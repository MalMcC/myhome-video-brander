const https = require('node:https');
const dns = require('node:dns');
const ipaddr = require('ipaddr.js');
const { load } = require('cheerio');

class BranchContactError extends Error {}

function officialUrl(value, domain) {
  let url;
  try { url = new URL(value); } catch {}
  const host = url?.hostname.toLowerCase().replace(/^www\./, '');
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host) || (domain && host !== domain)) {
    throw new BranchContactError('Use an HTTPS contact page on your agency’s official website.');
  }
  return { url, host };
}

function publicLookup(host, _options, callback) {
  dns.lookup(host, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const eligible = addresses.filter(({ address }) => ipaddr.process(address).range() === 'unicast');
    if (eligible.length !== addresses.length || !eligible.length) return callback(new Error('No public address'));
    if (_options.all) return callback(null, eligible);
    const { address, family } = eligible[0];
    callback(null, address, family);
  });
}

function fetchPublishedFile(url, domain, mime, limit, redirects = 2) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: publicLookup, headers: { Accept: 'text/html, image/*', 'User-Agent': 'MyDomi branch contact verification' } }, response => {
      if (redirects > 0 && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        try {
          const next = officialUrl(new URL(response.headers.location, url).href, domain).url;
          resolve(fetchPublishedFile(next, domain, mime, limit, redirects - 1));
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200 || !mime.test(response.headers['content-type'] || '')) {
        response.resume();
        reject(new Error('Contact page could not be read'));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > limit) response.destroy(new Error('Contact page is too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const deadline = setTimeout(() => request.destroy(new Error('Contact page timed out')), 8000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
  });
}

async function fetchOfficialPage(url, domain) {
  return (await fetchPublishedFile(url, domain, /^text\/html\b/i, 1_500_000)).toString('utf8');
}

function fetchPublicLogo(value) {
  const { url, host } = officialUrl(value);
  return fetchPublishedFile(url, host, /^image\//i, 7_000_000);
}

function normalPhone(value) {
  return value.replace(/\D/g, '').replace(/^(?:0044|44)0?/, '0');
}

function normalize(value) {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function publishedContacts(html, anchor, branch) {
  const $ = load(html);
  $('script,style,template,noscript,[hidden],[aria-hidden="true"]').remove();
  const section = anchor ? $('[id]').filter((_, e) => $(e).attr('id') === anchor).first() : $('main').first().length ? $('main').first() : $('body');
  if (!section.length || !normalize(section.text()).includes(normalize(branch.name))) return false;
  // Prefer a branch-sized block. This avoids mixing a branch heading with an
  // unrelated phone or email from a different office or from site navigation.
  const blocks = section.find('article,section,li,address,div,td').toArray().concat(section.toArray());
  const email = branch.email.toLowerCase();
  const phone = normalPhone(branch.phone);
  return blocks.some(node => {
    const block = $(node);
    const copy = normalize(block.text());
    if (!copy.includes(normalize(branch.name))) return false;
    const phones = block.find('a[href^="tel:"]').toArray().map(a => $(a).attr('href').slice(4));
    phones.push(...Array.from(copy.matchAll(/(?:\+44\s*\(0\)|\+44|0044|0)[\s().-]*(?:\d[\s().-]*){9,11}/g), match => match[0]));
    const emails = block.find('a[href^="mailto:"]').toArray().map(a => $(a).attr('href').slice(7).split('?')[0].toLowerCase());
    emails.push(...copy.match(/[\w.%+\-]+@[\w.\-]+\.[a-z]{2,}/g) || []);
    const publishedPhones = new Set(phones.map(normalPhone).filter(value => /^0\d{9,10}$/.test(value)));
    const publishedEmails = new Set(emails);
    // A container listing several unrelated contacts is not branch evidence.
    return publishedPhones.size === 1 && publishedPhones.has(phone) &&
      publishedEmails.size === 1 && publishedEmails.has(email);
  });
}

async function verifyBranchContacts(agentUrl, records, fetchPage = fetchOfficialPage) {
  const { host } = officialUrl(agentUrl);
  if (typeof records === 'string') {
    records = records.split(/\r?\n/).map(row => row.trim()).filter(Boolean).map(row => {
      const [name, phone, email, source, extra] = row.split('|').map(part => part.trim());
      return extra === undefined ? { name, phone, email, source } : {};
    });
  }
  if (!Array.isArray(records) || !records.length) throw new BranchContactError('Add the public contact details for every branch covered by the film.');
  const branches = [];
  const seen = new Set();
  const pages = new Map();
  for (const record of records) {
    const { name, phone, email, source } = record || {};
    if (![name, phone, email, source].every(value => typeof value === 'string' && value.trim()) ||
        name.length > 100 || phone.length > 32 || email.length > 100 ||
        !/^0\d{9,10}$/.test(normalPhone(phone)) || !/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email)) {
      throw new BranchContactError('Use one line per branch: branch name | public phone | public email | official contact page.');
    }
    if (seen.has(normalize(name))) throw new BranchContactError('List each branch once.');
    seen.add(normalize(name));
    const { url } = officialUrl(source, host);
    let anchor;
    try { anchor = decodeURIComponent(url.hash.slice(1)); }
    catch { throw new BranchContactError('Check the official branch contact link.'); }
    url.hash = '';
    let html = pages.get(url.href);
    if (html === undefined) {
      try { html = await fetchPage(url, host); }
      catch { throw new BranchContactError(`We couldn’t read the official contact page for ${name}. Check the link and try again.`); }
      pages.set(url.href, html);
    }
    if (!publishedContacts(html, anchor, { name, phone, email })) {
      throw new BranchContactError(`We couldn’t verify the published name, phone and email for ${name}. Use its individual branch page or section link.`);
    }
    branches.push({ name, phone, email });
  }
  return branches;
}
module.exports = { BranchContactError, verifyBranchContacts, fetchPublicLogo };
