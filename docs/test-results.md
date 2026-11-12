# Test evidence

Local run: 12 November 2026. Host: Windows, Node.js 22.21.0, PowerShell 5.1. Bitcoin Core image `bitcoin/bitcoin:30.4`; LND image `lightninglabs/lnd:v0.21.6-beta`; three nodes on regtest, synchronized at block 122 before testing. Source: uncommitted working tree. All payments used fictitious regtest satoshis. No preimage, access code, macaroon, seed, or raw request body appears here.

Docker Desktop and `scripts/dev.ps1` initialized the local nodes and copied restricted credentials. Integration checks reached the three published LND REST ports and exercised the app against those nodes.

| Gate | Result | Evidence and limit |
| --- | --- | --- |
| TypeScript server and web build | PASS | `npm run typecheck`; Vite production bundle built. |
| Unit/API suite | PASS | `npm test`: 8 tests across flow and API, including hash URL encoding and dispatched-state regression. Controlled LND responses; separate from real-node evidence. |
| Compose and PowerShell syntax | PASS | `docker compose config --quiet`; PowerShell 5.1 parser and crypto calls passed. |
| Authenticated LND REST | PASS | Buyer, seller, courier `/v1/getinfo` returned HTTP 200, synchronized at block 122. |
| Same-hash day-one chain (T03–T05) | PASS | `scripts/chain-gate.cjs`: seller incoming 11,000 sat hold `ACCEPTED` (HTLC expiry 269), courier incoming 1,000 sat hold `ACCEPTED` (expiry 197), seller outgoing `IN_FLIGHT` (route expiry 197). Courier settled; seller observed the matching outgoing preimage and settled the buyer hold; buyer sender `SUCCEEDED`. |
| Complete API journey (T46, partial T18) | PASS | `scripts/smoke.ps1` completed three consecutive orders after the final state fix: `c9eb3349`, `76fe1731`, `ed57ba80`. Both sender payments `SUCCEEDED` and both receiver invoices `SETTLED` for each. Balance deltas and browser contexts remain unmeasured. |
| Cancel held payment (T09) | PASS | Two incomplete test orders (`e77d5557`, `f97df056`) were canceled through the buyer API. The buyer sender reached `FAILED` before the order phase became `CANCELED`. |
| Release job restart (T24–T26) | PASS | For order `f7fc6cc6`, the app was stopped just after authorization. SQLite showed `RELEASE_PENDING` with an encrypted job present. After restart, both invoices were `SETTLED`, both senders `SUCCEEDED`, the phase was `COMPLETED`, and the job was cleared. |
| Restricted node credentials (T37) | PASS | The courier runtime macaroon denied `SendPaymentV2`; the buyer runtime macaroon denied on-chain `SendCoins`. LND returned `permission denied` for both. |
| Browser happy path (T46, partial) | PASS | Order `6b6427c7` was created and completed through the actual web UI, switching among seller, buyer, and courier roles in one browser. The buyer held 11,000 sat, the seller prepared delivery, the courier marked pickup, and the buyer copied the release code after showing the QR. The courier pasted it and confirmed. UI showed Paid for both legs; SQLite showed COMPLETED with the encrypted release job cleared; direct LND queries showed both invoices SETTLED and both outgoing payments SUCCEEDED. |
| Camera and independent-device journey (T47–T52) | NOT RUN | QR camera scanning, separate browser profiles, and mobile layout still need direct testing. |
| Balance and fee accounting (T18) | NOT RUN | Measure channel balance deltas on fresh orders before claiming exact economic accounting. |
| Remaining fault matrix (T10–T17, T20–T23, T27–T36, T38–T39) | NOT RUN | Remaining races, node outages, block cutoffs, and privacy checks need dedicated tests. |

Two defects were found and fixed during real-node testing: unpadded or standard base64 hashes containing `/` broke REST tracking, and the worker could regress `DISPATCHED` to `READY_FOR_PICKUP`. Regression coverage was added for both. Earlier failed smoke attempts are excluded from the three consecutive passes.

During the browser run, an earlier active order (`7f5e3177`) could not show its QR in this browser because its secret was stored in a different buyer profile. The UI reported the missing secret, and cancellation reached CANCELED with both holds canceled. The new order used one browser for its entire buyer session. A **Copy release code** button was added so a courier can paste the code when a second camera is unavailable; the button and paste flow were exercised in the browser run. Rebuilding the web assets required restarting the running Fastify server because its static-file manifest did not discover the newly named bundle while running.

This evidence supports a **functional regtest payment prototype**, not production security or arbitrary-wallet compatibility.
