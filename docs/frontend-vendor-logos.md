# Frontend vendor logos

These are unchanged official site icons, retrieved on 2026-09-04 and served
locally beside each vendor's name. No generated or recreated marks are used.

| Vendor | Local asset | Official source |
| --- | --- | --- |
| Phygitals | `apps/frontend/public/vendor-logos/phygitals.jpg` | The `rel="icon"` asset published by [Phygitals documentation](https://docs.phygitals.com/), sourced from its GitBook `1080x1080pfpwhite.png` icon and delivered as a 48px JPEG. |
| Collector Crypt | `apps/frontend/public/vendor-logos/collector-crypt.svg` | [Official website icon](https://collectorcrypt.com/logo.svg), linked by the site's `rel="icon"`. |
| ClutchPacks | `apps/frontend/public/vendor-logos/clutchpacks.png` | [Official website icon](https://d18ez2bunk7yz0.cloudfront.net/web/favicon.png), linked by [ClutchPacks](https://clutchpacks.io/). |

`VendorIdentity.tsx` owns the frontend asset registry. Unknown vendors remain
text-only until an official asset is verified. Logos have empty alt text
because the adjacent vendor name supplies the accessible identity.
