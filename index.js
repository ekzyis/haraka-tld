'use strict';

// node build-ins
const fs       = require('fs');
const path     = require('path');

// npm modules (dependencies)
const punycode = require('punycode');

// local deps
const update   = require('./lib/update');

const regex = {
  comment:        /^\s*[;#].*$/,
  blank:          /^\s*$/,
  line:           /^\s*(.*?)\s*$/,
}

const logger = {
  log: (message) => {
    switch (process.env.HARAKA_LOGS_SUPPRESS) {
      case undefined:
      case "false":
      case "0":
        console.log(message);
    }
  },
};

module.exports = exports = {
  public_suffix_list: {},
  top_level_tlds: {},
  two_level_tlds: {},
  three_level_tlds: {},
}

function normalizeHost (host) {
  host = host.toLowerCase();

  if (/^xn--|\.xn--/.test(host)) {
    try { host = punycode.toUnicode(host); }
    catch (ignore) {}
  }

  return host;
}

exports.is_public_suffix = function (host) {
  if (!host) return false;
  host = normalizeHost(host);

  if (exports.public_suffix_list[host]) return true;

  const up_one_level = host.split('.').slice(1).join('.'); // co.uk -> uk
  if (!up_one_level) return false;   // no dot?

  const wildHost = `*.${  up_one_level}`;
  if (exports.public_suffix_list[wildHost]) {
    // check exception list
    if (exports.public_suffix_list[`!${host}`]) return false;
    return true;           // matched a wildcard, ex: *.uk
  }

  return false;
}

exports.get_organizational_domain = function (host) {
  // the domain that was registered with a domain name registrar. See
  // https://datatracker.ietf.org/doc/draft-kucherawy-dmarc-base/?include_text=1
  //   section 3.2

  if (!host) return null;
  host = normalizeHost(host);

  // www.example.com -> [ com, example, www ]
  const labels = host.split('.').reverse();

  // 4.3 Search the public suffix list for the name that matches the
  //     largest number of labels found in the subject DNS domain.
  let greatest = 0;
  for (let i = 1; i <= labels.length; i++) {
    if (!labels[i-1]) return null;                   // dot w/o label
    const tld = labels.slice(0,i).reverse().join('.');
    if (exports.is_public_suffix(tld)) {
      greatest = +(i + 1);
    }
    else if (exports.public_suffix_list[`!${tld}`]) {
      greatest = i;
    }
  }

  // 4.4 Construct a new DNS domain name using the name that matched
  //     from the public suffix list and prefixing to it the "x+1"th
  //     label from the subject domain.
  if (greatest === 0) return null;             // no valid TLD
  if (greatest  >  labels.length) return null; // not enough labels
  if (greatest === labels.length) return host; // same

  const orgName = labels.slice(0, greatest).reverse().join('.');
  return orgName;
}

exports.split_hostname = function (host, level) {
  if (!level || (level && !(level >= 1 && level <= 3))) {
    level = 2;
  }

  const split = host.toLowerCase().split(/\./).reverse();
  let domain = '';
  // TLD
  if (level >= 1 && split[0] && exports.top_level_tlds[split[0]]) {
    domain = split.shift() + domain;
  }
  // 2nd TLD
  if (level >= 2 && split[0] && exports.two_level_tlds[`${split[0]}.${domain}`]) {
    domain = `${split.shift()}.${domain}`;
  }
  // 3rd TLD
  if (level >= 3 && split[0] && exports.three_level_tlds[`${split[0]}.${domain}`]) {
    domain = `${split.shift()}.${domain}`;
  }
  // Domain
  if (split[0]) {
    domain = `${split.shift()}.${domain}`;
  }
  return [split.reverse().join('.'), domain];
}

function load_public_suffix_list () {
  load_list_from_file('public-suffix-list').forEach((entry) => {
    // Parsing rules: http://publicsuffix.org/list/
    // Each line is only read up to the first whitespace
    const suffix = entry.split(/\s/).shift();

    // Each line which is not entirely whitespace or begins with a comment
    // contains a rule.
    if (!suffix) return;                            // empty string
    if ('/' === suffix.substring(0,1)) return;      // comment

    // A rule may begin with a "!" (exclamation mark). If it does, it is
    // labelled as a "exception rule" and then treated as if the exclamation
    // mark is not present.
    if ('!' === suffix.substring(0,1)) {
      const eName = suffix.substring(1);   // remove ! prefix
      // bbc.co.uk -> co.uk
      const up_one = suffix.split('.').slice(1).join('.');
      if (exports.public_suffix_list[up_one]) {
        exports.public_suffix_list[up_one].push(eName);
      }
      else if (exports.public_suffix_list[`*.${up_one}`]) {
        exports.public_suffix_list[`*.${up_one}`].push(eName);
      }
      else {
        console.error(`unable to find parent for exception: ${eName}`);
      }
    }

    exports.public_suffix_list[suffix] = [];
  })

  logger.log(`loaded ${Object.keys(exports.public_suffix_list).length} Public Suffixes`);
}

function load_tld_files () {
  load_list_from_file('top-level-tlds').forEach(function (tld) {
    exports.top_level_tlds[tld] = 1;
  })

  load_list_from_file('two-level-tlds').forEach(function (tld) {
    exports.two_level_tlds[tld] = 1;
  })

  load_list_from_file('three-level-tlds').forEach(function (tld) {
    exports.three_level_tlds[tld] = 1;
  })

  load_list_from_file('extra-tlds').forEach(function (tld) {
    const s = tld.split(/\./);
    if (s.length === 2) {
      exports.two_level_tlds[tld] = 1;
    }
    else if (s.length === 3) {
      exports.three_level_tlds[tld] = 1;
    }
  })

  logger.log(`loaded TLD files:
  1=${Object.keys(exports.top_level_tlds).length}
  2=${Object.keys(exports.two_level_tlds).length}
  3=${Object.keys(exports.three_level_tlds).length}`
  );
}

function load_list_from_file (name) {
  const result = [];

  let filePath = path.resolve(__dirname, 'etc', name);
  if (!fs.existsSync(filePath)) {
    // not loaded by Haraka, use local path
    filePath = path.resolve('etc', name);
  }

  fs.readFileSync(filePath, 'UTF-8')
    .split(/\r\n|\r|\n/)
    .forEach((line) => {

      if (regex.comment.test(line)) return;
      if (regex.blank.test(line))   return;

      const line_data = regex.line.exec(line);
      if (!line_data) return;

      result.push(line_data[1].trim().toLowerCase());
    });
  return result;
}

load_tld_files();
load_public_suffix_list();

// every 15 days, check for an update. If updated, download, install,
// and then read it into the exported object
setInterval(() => {
  update.updatePSLfile().then(updated => {
    if (updated) load_public_suffix_list();
  }).catch((err) => {
    console.error(err.message)
  });
}, 15 * 86400 * 1000).unref(); // each 15 days

// the .unref() on the interval tells node to ignore this
// timer when deciding whether the process is done.
