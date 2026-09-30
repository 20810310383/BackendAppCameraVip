# Cloudflare R2 media storage

This backend uses R2 only when every R2 environment variable below is set.
Without them, local development keeps the existing `/uploads/...` behaviour.

## 1. Create the bucket

In Cloudflare Dashboard go to **Storage & databases** -> **R2** -> **Overview**.
Create a bucket named `app-media-prod` and leave its default storage class as
Standard. Bucket names must use lowercase letters, digits, and hyphens only.

## 2. Create a public media URL

The mobile app loads media directly from R2, so it needs a read URL. For a
production app, connect a custom domain such as `media.example.com`:

1. Add the root domain to the same Cloudflare account.
2. Select the R2 bucket -> **Settings** -> **Custom Domains** -> **Add**.
3. Connect `media.example.com` and wait until its status is **Active**.

For a short test only, **Settings** -> **Public Development URL** -> **Enable**
provides an `https://<bucket>.<id>.r2.dev` URL. Do not use `r2.dev` for a
production app because it is rate-limited and cannot use caching or access
rules.

This preserves the old server behaviour: `/uploads/...` was publicly readable
already. If private post media is required later, use signed read URLs rather
than making the bucket public.

## 3. Create the server token

Go to **R2** -> **Overview** -> **Manage R2 API Tokens** -> **Create Account
API Token**. Choose:

- Permission: **Object Read & Write**
- Bucket scope: **Apply to specific buckets only** -> `app-media-prod`
- Expiration: leave empty for the VPS token, or rotate it before the expiry.

Copy the **Access Key ID**, **Secret Access Key**, and S3 endpoint displayed at
creation time. The secret is displayed once only. It belongs only on the VPS;
never put it in the Expo app or commit it to Git.

## 4. Configure the VPS

Put real values into `Backend/.env` on the VPS (not `.env.example`):

```env
R2_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
R2_BUCKET=app-media-prod
R2_ACCESS_KEY_ID=your-access-key-id
R2_SECRET_ACCESS_KEY=your-secret-access-key
R2_PUBLIC_BASE_URL=https://media.example.com
```

Restart the backend after updating `.env`. A new upload will then follow this
flow:

```text
mobile app -> VPS memory/temp file -> optimize -> R2 -> remove VPS temp file
```

The database stores the final R2 URL. Images, videos, video thumbnails, moment
audio, chat attachments, wallpapers, profile pictures, and group avatars use
this flow. Deleting the matching post/message/avatar also deletes its R2 object.

## 5. Move cold moment files after 90 days

In the bucket's **Settings** -> **Object Lifecycle Rules**, add a transition to
**Infrequent Access** after 90 days for these prefixes:

- `media/moments/images/`
- `media/moments/videos/`
- `media/moments/audio/`

Do not create that rule for `media/moments/thumbnails/`, profile pictures, or
group avatars; these are small files that the UI needs immediately. R2 moves
the same bytes to the lower-cost storage class; it does not compress or change
quality a second time.

## Existing local media

Only new uploads go to R2. Existing files in `Backend/uploads` are intentionally
left untouched so old posts do not break. Do not delete that folder until those
objects have been migrated and their database paths updated.
