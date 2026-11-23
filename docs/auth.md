# Authentication design (phone, QR, tdata)

Status: **design fixed 2026-11-16**, Phase 1 backend implemented in `apps/api`.
Phase 2 added QR WS events and `.tar.gz` tdata archives. The app is
**single-user**: there is no local registration or login. Live MTProto flows were
exercised against a real tdata account (`getMe`/`sendText`), but phone/QR paths
have not been tested end to end.

Client library: `@mtcute/node` 0.32.x. tdata: `opentele2` 2.0. All flows end in the
same result: a `TelegramAccount` slot + encrypted `TelegramSession` (see
`docs/architecture.md`). Reference for the Telegram flows: official Telegram
Desktop / 64Gram source in `inspiration/repos/64Gram` and
`inspiration/repos/ForkgramDesktop`.

## 0.1 Local app user (single-user mode)

The local user is not a Telegram account: it owns 0..N `TelegramAccount` slots.
There is no registration or login. `DefaultUserService` upserts
`DEFAULT_USER_ID` (default `local`) and `DefaultUserGuard` attaches it to every
HTTP request; `@CurrentUser()` returns it. WS sockets join `user:<id>` with no
token. Replace both before any shared deployment.

## 0. Common rules

- One `AuthAttempt` per login. It holds a live mtcute client in memory and is
  **sticky to the node** that created it (Redis key `auth:attempt:<id>:node`).
- Every auth flow takes `deviceId` (8..128 chars, `[A-Za-z0-9._:-]`) and an
  optional `profile`. `deviceId` is the session slot: a new id adds a session
  under the same `TelegramAccount`, the same id replaces that session's key.
  There is no account-level cap beyond `MAX_ACCOUNTS_PER_USER`; each account
  can hold `MAX_SESSIONS_PER_ACCOUNT` sessions (default 10), which is how a PC
  and a phone are logged in at the same time.
- Phone codes and 2FA passwords are never persisted, logged or put in WS events.
  `AuthAttempt.payload` stores only method/profile/deviceId/phone tail and status.
- Every failure returns a stable `code` + human message; Telegram `FLOOD_WAIT_X`
  becomes `retryAfter` seconds.
- After success: account info from the login → upsert account by
  `(userId, tgUserId)` → encrypt session with AAD `session:<accountId>` → keep the
  authenticated client live and mark the attempt `ok`.
- Profiles: `desktop` → TelegramDesktop, `mobile` → TelegramAndroid,
  `android-x` → TelegramAndroidX, `ios`, `macos`, `web-a`, `web-k`, `webogram`.
  `TELEGRAM_API_MODE=official` uses opentele2's bundled credentials (violates
  ToS 2.1, warning at boot); `custom` uses `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`
  and `TELEGRAM_DEVICE_*`. Unknown keys return `400 PROFILE_UNKNOWN`; missing
  custom credentials return `503 NOT_CONFIGURED`.

## 1. Phone + code (+ 2FA)

### Flow

```
start(phone) ──▶ auth.sendCode ──▶ codeType/timeout
    │
    ├── verify(code) ──▶ auth.signIn ──┬── authorization ──▶ done
    │                                  ├── SESSION_PASSWORD_NEEDED ──▶ password(password)
    │                                  ├── SIGN_UP_REQUIRED ──▶ signup(first, last)
    │                                  └── code errors ──▶ retry
    ├── resend() ──▶ auth.resendCode
    └── cancel() ──▶ auth.cancelCode
```

### API

```
POST /auth/phone/start    { phone, deviceId, profile?, label?, proxyId? }
  → { attemptId, codeType: "app"|"sms"|"call"|"flash"|"other", timeout, nextType? }

POST /auth/phone/verify   { attemptId, code }
  → { status: "ok", account }
  | { status: "password_required" }
  | { status: "signup_required" }

POST /auth/phone/password { attemptId, password }   → { status: "ok", account }
POST /auth/phone/signup   { attemptId, firstName, lastName } → { status: "ok", account }
POST /auth/phone/resend   { attemptId }             → new timeout/nextType
POST /auth/phone/cancel   { attemptId }
```

mtcute:
- `tg.sendCode({ phone })` → `phoneCodeHash`, `type`, `timeout`, `nextType`.
- `tg.signIn({ phone, phoneCodeHash, phoneCode })`.
- `tg.checkPassword(password)` (SRP handled by the library).
- `tg.resendCode(...)`, `tg.cancelCode(...)`.

Telegram side (`auth.sendCode`):
- `phone_number`, `api_id`, `api_hash`, `code_settings`:
  `device_model`, `system_version`, `app_version`, `system_lang_code`,
  `lang_pack`, `lang_code`.
- Keep the device profile **stable per account**; changing it on every login looks
  suspicious.

### Error map

| Telegram error | HTTP `code` | UX |
| --- | --- | --- |
| `PHONE_NUMBER_INVALID` | `PHONE_INVALID` | fix number |
| `PHONE_NUMBER_BANNED` | `PHONE_BANNED` | account banned, stop |
| `PHONE_CODE_INVALID` / `PHONE_CODE_EMPTY` | `CODE_INVALID` | retry code |
| `PHONE_CODE_EXPIRED` | `CODE_EXPIRED` | resend |
| `SESSION_PASSWORD_NEEDED` | `PASSWORD_REQUIRED` | show 2FA step |
| `PASSWORD_HASH_INVALID` | `PASSWORD_INVALID` | retry (bounded) |
| `SIGN_UP_REQUIRED` | `SIGNUP_REQUIRED` | ask first/last name |
| `FLOOD_WAIT_X` | `FLOOD_WAIT` + `retryAfter` | countdown |
| `PHONE_NUMBER_FLOOD` | `PHONE_FLOOD` | stop, suggest another number |

Reference: `intro/intro_phone.cpp` (sendCode), `intro/intro_code.cpp`
(signIn + error handling), `intro/intro_password_check.cpp` and
`core/core_cloud_password.cpp` (SRP), `intro/intro_signup.cpp` (signUp).

## 2. QR login

### Flow (official, `intro/intro_qr.cpp`)

```
auth.exportLoginToken(api_id, api_hash, except_ids)
  ├── auth.loginToken { token, expires } ──▶ show tg://login?token=<base64url>
  │        └── refresh when expires (or on updateLoginToken)
  ├── auth.loginTokenMigrateTo { dc_id, token }
  │        └── switch DC ──▶ auth.importLoginToken(token) ──▶ repeat
  └── auth.loginTokenSuccess { authorization } ──▶ done

SESSION_PASSWORD_NEEDED ──▶ account.getPassword ──▶ auth.checkPassword(SRP) ──▶ done
```

- Token is rendered as `tg://login?token=` + base64url (that is what the official
  clients scan: **Settings → Devices → Link Desktop Device**).
- The token lives ~30 seconds; refresh on expiry and on `updateLoginToken`.
- `except_ids` should exclude accounts that must not receive the login (usually
  empty for a fresh client).
- `auth.acceptLoginToken` is only needed on the *already logged-in* device that
  scans the QR. Our web app shows the QR; scanning happens in the user's official
  app, so we do not call it.

### API

```
POST /auth/qr/start { deviceId, profile?, label?, proxyId? }
                                → { attemptId, url, expiresAt }
GET  /auth/qr/:attemptId        → { status, url?, expiresAt?, error?, account? }
POST /auth/qr/:attemptId/password { password }
POST /auth/qr/:attemptId/cancel
```

Attempt statuses: `pending` (QR shown), `scanned`, `password_required`, `ok`,
`failed`, `expired`. The QR client runs in the background (`signInQr`) and
waits for the 2FA password on a deferred promise, so the token and client stay
on one node. Cancel resolves the deferred with an empty password, aborts the
signal and destroys the client.

WS events: `auth.qr.updated` (`{ attemptId, url, expiresAt }`),
`auth.qr.scanned` (`{ attemptId }`), `auth.password_required`
(`{ attemptId, error? }`), `auth.done` (`{ attemptId, account }`) and
`auth.failed` (`{ attemptId, error }`). HTTP polling keeps working unchanged.

mtcute: `tg.start({ qrCodeHandler, password })` or the lower-level `tg.signInQr(...)`.
The handler is called again whenever the URL changes.

## 3. tdata upload

### What tdata is

`tdata` is the Telegram Desktop login folder: `key_datas` + per-account files.
It is a **credential**, not a cache — whoever has it is logged in, 2FA does not
protect against a copied folder. Optional local passcode wraps the local key
(Argon2id/scrypt in tdesktop 7.3+).

Structure: `tdata/key_datas`, `tdata/<hex>/` + `<hex>` MTP files, `maps`,
`configs`; files start with `TDF$` and end with an MD5 trailer. A folder holds up
to 6 accounts.

### Import strategies

| Mode | What happens | When |
| --- | --- | --- |
| `new_session` (**default**) | Parse tdata, open the imported session, then authorize a **new** session by QR (`qrLoginToNewClient`). Our account gets its own auth key. | Recommended: desktop keeps working independently, Devices shows two sessions |
| `reuse` | Import the tdata auth key directly into mtcute and use it. | Fast/offline, but two clients share one session: read state, typing and updates conflict, and Devices shows one device |

Never run `reuse` silently: warn the user that two clients will share one session.

### API

```
POST   /auth/tdata              multipart: file (.zip | .tar.gz | .tgz), passcode?
  → { uploadId, accounts: [{ index, userId }] }

POST   /auth/tdata/:id/import   { indexes?: number[], mode: "new_session"|"reuse",
                                  deviceId, profile?, label?, password?, proxyId? }
  → { accounts: [{ account, mode, warning? }] }

DELETE /auth/tdata/:id
```

`.zip`, `.tar.gz` and `.tgz` are accepted (max 512 MB); the format is chosen by
the file extension. `indexes` defaults to every account in the folder. Upload returns account metadata only (no names/phones — that would need a
network connection); names are filled in on import via `getMe()`. The archive is
deleted immediately after extraction, and the extracted folder + `TdataUpload`
row are removed in a `finally` after import/cancel/expiry (15 min).

### Pipeline

1. Stream upload to `TELEGRAM_TMP_DIR/<uuid>` (mode 0700/0600), cap size
   (default 512 MB). Zip entries are checked for traversal; tar extraction
   filters out `..`, absolute/Windows paths and link/device entries before
   writing (zip-slip protection for both formats).
2. Extract, require `tdata/key_datas`, verify `TDF$` magic.
3. `loadTdata(dir, passcode?)` → accounts. Wrong passcode → `TDATA_BAD_PASSCODE`.
4. Return account metadata only (no keys, no phone).
5. On import: `new_session` or `reuse` as above; `getMe()` to verify.
6. Store encrypted session; **shred the upload** (unlink files + dir) in a
   `finally`.
7. Attempt expires after 15 minutes; a sweeper removes leftovers.

opentele2:
- `loadTdata(path, passcode?)`, `profile('TelegramDesktop')`,
  `initConnectionOptions(profile)`, `toStringSession(account)` (exported from
  `opentele2/mtcute`), `qrLoginToNewClient(...)` from `opentele2/mtcute`.

Clients that touch tdata always use Telegram Desktop's official api id/hash, even
when `TELEGRAM_API_MODE=custom`: the auth key in the folder was created with
those credentials. `new_session` therefore imports the tdata key into an
"authorized" client (Desktop credentials), then lets opentele2's QR flow create a
**fresh** session for the profile requested by the API (`profile`/`mobile`, ...).
`reuse` stores the Desktop session directly and returns a
`SHARED_DESKTOP_SESSION` warning.

Reference: tdesktop `storage/storage_domain.cpp` (key file/passcode) and 64Gram
`main/main_domain.cpp` (account slots).

## 4. Phone profile and device identity

- With `TELEGRAM_API_MODE=custom`, sessions present the operator's own
  `api_id`/`api_hash` (one app, one key pair). `official` uses opentele2's
  bundled official profiles and logs a ToS 2.1 warning; it is a development
  convenience, not a deployment mode.
- `device_model`, `system_version`, `app_version`, `lang` come from the resolved
  profile and are stored as a JSON snapshot in `TelegramAccount.deviceProfile`
  plus the session row (`platform`, `profile`).
- tdata `reuse` keeps the Telegram Desktop device profile (opentele2 provides it).
- Do not claim to be an official Telegram app: no official logo, no "Telegram"
  in the product name without "Unofficial".

## 4.1 TDLib login and tdata migration

`tdata` is a Telegram Desktop storage format; TDLib has no API to import its
auth key. The bridge keeps `tdata` usable anyway:

1. `opentele2` + mtcute open the `tdata` session (official Desktop `api_id`).
2. A new native TDLib client (official Android profile by default) calls
   `requestQrCodeAuthentication` and gets `tg://login?token=...`.
3. The mtcute session immediately approves it with raw `auth.acceptLoginToken`.
   This works for an imported `tdata` and for any existing account.
4. If TDLib asks for the cloud password, the stored one is used or the UI asks;
   it is sealed with AES-256-GCM and never logged.
5. The TDLib auth key is stored in its own encrypted database under
   `TDLIB_DATA_DIR/sessions/<deviceId>`; the account gets a second session row
   with `engine = "tdlib"`.

The mtcute/Desktop session is not logged out. That keeps an escape hatch and
avoids signing the user out of Telegram Desktop; it can be removed manually in
Telegram's Devices menu.

The phone-code path (`setAuthenticationPhoneNumber`) is implemented for new
accounts. Forwarding the code from the `777000` service chat proved unreliable:
Telegram sends that code by SMS, so QR is the primary flow.

## 5. Security requirements

1. Session keys encrypted with AES-256-GCM (see architecture doc).
2. tdata archive exists on disk only between upload and import; no backups.
3. No phone codes, 2FA passwords or auth keys in logs, DB dumps, Sentry or WS.
4. Rate limit: per IP, per phone (hashed), per account; respect `FLOOD_WAIT_X`.
5. Passcode for tdata is optional but supported; if the folder is locked, require
   it and never store it.
6. Warn before tdata upload: full access to the account, revoke via Devices if
   anything looks wrong.
7. Terminating a session (`auth.logOut`) is explicit and confirmed; local detach
   is the default delete action.
8. The cloud password is stored only to answer `authorizationStateWaitPassword`
   (AAD `cloud:<accountId>`), can be deleted from the UI, and must never be
   written to logs or error messages.

## 6. ToS constraints (affect what we build)

- No ghost mode, no hiding online/read status, no anti-delete, no keeping
  self-destructing content, no "local premium". These are named in
  <https://core.telegram.org/api/terms> §1.4 and can cost the app its API access.
- Accounts that log in through unofficial clients are automatically put under
  observation; spam/flood/automation leads to permanent bans.
- Users see a "may reduce security" label for unofficial clients since 2026-03-31.

## 7. Test plan for the spike

1. Phone: send code → wrong code → correct code → 2FA → `getMe()`.
2. QR: export token → scan from a real phone → token refresh path →
   `SESSION_PASSWORD_NEEDED` → `getMe()`.
3. tdata: locked and unlocked folder → wrong passcode → 2 accounts in one folder →
   `new_session` import → `getMe()`; then `reuse` on a throwaway account only.
4. Multi-account: two accounts in one local user, switch, both receive updates,
   remove one locally, revoke the other.
5. Negative: expired QR, FLOOD_WAIT, banned number, no-network mid-flow.
