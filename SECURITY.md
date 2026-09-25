# Security Policy

FISHFINDER is a static website, [fishnames.net](https://fishnames.net/), served
by GitHub Pages, plus a small Firebase Realtime Database that stores anonymous
usage statistics and the reports sent with the site's REPORT button. Manuscript
text is processed entirely in the browser and is never sent anywhere.

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](https://github.com/zdzbinden/FISHFINDER/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**), not in a
public issue or through the site's REPORT form.

Say what you found, where, and how to reproduce it. FISHFINDER is a small
academic project maintained by one person, so there is no bug bounty, but
good-faith reports are welcome and will be credited if you wish.

Only the live site and the `main` branch are supported.

When testing, please do not run automated scanners or load tests against
fishnames.net or its database, and do not write to, change or delete database
records beyond what the site itself does.

## Public by design

These are intentional and are not vulnerabilities:

- **The Firebase web configuration in `fishfinder/js/app.js`, including its
  `apiKey`.** A Firebase web key identifies the project; it does not grant
  access. Access is decided by the database rules in `database.rules.json`, not
  by keeping the key secret.
- **The usage-map records**: city, country, coordinates rounded to about 1 km,
  and the hour of a visit. They draw the public map; reads are capped at the
  newest 500.
- **Anonymous writes.** Visitors can add a visit record (with consent) or a
  report, because the site has no accounts. Both are validated and create-only.
  Visitors cannot read reports back or delete anything.
