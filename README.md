# just us. | End-to-end encrypted temporary chat

A beginner-friendly starter using HTML, CSS, JavaScript, Node.js, Socket.IO and the browser Web Crypto API.

## What it does

- Creates a room for at most two connected people and generates a private invitation.
- Encrypts message text, reply context and photos in the sender's browser using AES-256-GCM.
- Uses a fresh random 96-bit IV for each encrypted message.
- Keeps the raw encryption key in the invitation URL fragment (`#key=...`). Browsers do not include URL fragments in HTTP requests, so the key is not sent in the normal request to the server.
- Relays and stores only ciphertext, IV, sender display name, sender socket ID, message ID and timestamp on the server.
- Does not use a database or write uploaded photos to disk.
- Clears room data from the process's RAM after both users disconnect and a 15-second grace period, or when the room expires after 12 hours.
- Retains up to 100 encrypted messages and limits photos to 1 MiB.

## Requirements

- Node.js 20 or newer
- npm (included with Node.js)
- A modern browser with Web Crypto support

## Run it on your computer

1. Install Node.js from https://nodejs.org/.
2. Extract the ZIP.
3. Open Terminal or PowerShell in the project folder.
4. Run `npm install`.
5. Run `npm start`.
6. Open http://localhost:3000.
7. Enter a display name and click **Create a room**.
8. Copy the entire invitation link and send it privately to your friend.

`localhost` works only on your computer. To chat across the internet, deploy to a host supporting a persistent Node.js process, WebSockets and HTTPS, then share the deployed HTTPS link.

## Deploying

Use a hosting provider that supports a persistent Node.js web service and WebSockets. Typical settings:

- Install/build command: `npm install`
- Start command: `npm start`
- Node.js: 20 or newer

Use HTTPS. Web Crypto requires a secure context, except for localhost. Keep this starter on a **single server instance**: each instance has its own in-memory room map. Multiple instances will not share rooms.

## How the encryption works

- The browser generates a cryptographically random 32-byte key.
- AES-GCM encrypts a JSON payload containing message text, reply context and any selected photo.
- Each message uses a new random 12-byte IV. Reusing an IV with the same AES-GCM key is unsafe; this code generates a fresh one for each send.
- Additional authenticated data binds the encrypted payload to the room ID, message ID, sender socket ID and timestamp. Changes to those fields cause decryption to fail.
- The server never receives plaintext text, reply context, photo data or the room encryption key. It stores opaque ciphertext in RAM and relays it to the other browser.
- The recipient decrypts the content locally using the key from the invitation fragment.

## Privacy and security limitations

**This is a learning starter, not an audited secure messenger. Do not use it for highly sensitive communications without a security review.**

1. **Web-host trust:** the server delivers `app.js` to browsers. A malicious or compromised host could serve modified JavaScript that steals the key or plaintext. Browser-based E2EE cannot protect you from a malicious client script delivered by the service itself. For stronger assurance, publish and independently verify the client code, use a carefully controlled deployment, and consider a mature audited protocol/application.
2. **The invitation link is a secret.** It contains both a room access token and the encryption key. Anyone who obtains the full link may be able to join while the room has space and decrypt its messages. Send it privately; don't post it publicly.
3. **No identity verification.** The key is shared through the invitation link, but the app does not verify that the person joining is actually your intended friend. Confirm the link recipient through another trusted channel.
4. **Metadata remains visible to the server.** The server sees display names, socket IDs, room membership, message sizes, timestamps, IP/connection metadata available to the host, and ciphertext. It can block, delay, reorder or drop messages.
5. **Not forward-secret.** Both participants use one room key. If that key is later exposed, previously captured ciphertext may be decryptable. A production messenger should use an audited protocol with authenticated key agreement and forward secrecy.
6. **No defense against compromised devices.** Malware, browser extensions, screenshots, screen recording, copy/paste or a recipient saving content can expose messages.
7. **RAM-only is not certified secure erasure.** Room objects are removed and references dropped, but JavaScript and the operating system do not promise immediate physical overwriting of memory.
8. **Host logs are outside this app.** The app does not intentionally log message contents, but hosting infrastructure may log IP addresses, request metadata or connection times. Review your provider's policy.
9. **No persistent message history.** Server restart/crash clears rooms and disconnects everyone. This is intentional.
10. **Single process only.** Don't scale this version to multiple instances without redesigning room routing and state management.
11. **Photos are limited to 1 MiB.** The browser reads a selected photo to preview and encrypt it. The server receives only the encrypted message payload.

## Basic troubleshooting

- `node` or `npm` not found: install Node.js, then reopen your terminal.
- Friend cannot open the link: `localhost` only works on your computer. Deploy the app and share its public HTTPS URL.
- Room not found: server restarted, room expired, or both users left. Create a new room and share a new invitation.
- "Couldn't decrypt" message: check that both users opened the full same invitation link, including the fragment after `#key=`.
- Photo rejected: use JPG, PNG, WebP or GIF, under 1 MiB.
- Browser says secure encryption unavailable: use `localhost` or a valid HTTPS deployment.

## Before using it for anything sensitive

This is a demonstration implementation of client-side encryption. It has not been penetration-tested or independently audited. Use an established end-to-end encrypted messenger for sensitive communications.
