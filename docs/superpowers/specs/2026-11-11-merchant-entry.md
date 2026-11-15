# Independent merchant entry

User confirmed `merchant.jinxiaodun.top` as a separate Node + reverse-proxy website. Existing API, database, admin/player sites, business permissions and all backups remain in use.

- Deploy a small independent `/www/studio-merchant` project with a loopback Node entry on3009; Nginx owns the new hostname and HTTPS. Serve existing verified `/www/studio-app/dist` read-only, without changing its file bytes or the running72540 application release.
- Proxy only to the configured fixed API origin (default127.0.0.1:3007), force merchant channel, forward only merchant session Cookie and accept only merchant Set-Cookie. Preserve Origin and original request Host; the existing API checks their same-origin relationship. Do not loosen allowed origins, strip Origin, start another business API or open another database.
- Inject a blocking same-origin `/merchant-entry.js` before app modules when serving indexHTML; valid merchant hashes retain deep links and query, all other hashes select merchant login. Construct replacements with newURL(location.href), never an untrusted path as a new origin.
- Keep static files byte-identical, deny alternateHTML/private files/traversal, no-store entryHTML/entryJS. Keep API response cache disabled and preserve upload bytes, actor/version/request identities and private image authorization.
- User operates production manually. Deliver source/checksum/config/short instructions, verify new project locally before DNS/proxy/HTTPS instructions. Existing service remains online during this addition. Earlier backup cleanup and production UI/backup acceptance remain outstanding.
