# Connectors — adding a new service

A connector lets the assistant watch another service (an order system, a monitoring tool, a helpdesk…) and treat its new records like any other message: extract tasks, update open items, answer questions about them.

**Connectors are data, not code.** The model never gets to run anything it wrote. It only proposes a small *manifest* describing one read-only HTTPS `GET`; the assistant's own fixed code does the polling.

## The flow
Everything happens in Chat (or `POST /chat`):

1. **Propose** — send the service's docs:
   ```
   connector https://docs.acme.example/api/orders
   ```
   or paste the docs text after `connector `. (URLs are fetched server-side with the same safety rules as below.) Claude reads them and proposes a manifest; the assistant validates it and replies with a plain-English summary and an approval number:
   > Proposed connector "acme" — approval #7: Open orders · GET https://api.acme.example/v1/orders every 15 min (read-only) · reads: status, note · auth: credential ACME_API_KEY (bearer)
2. **Approve the design** — `approve 7`. Nothing runs yet.
3. **Add the credential yourself** — on the server, so the model never sees it:
   ```bash
   read -rs v; echo "$v" | docker compose run --rm -T assistant npm run secret -- set ACME_API_KEY
   ```
   (stored in `data/secrets.json`, mode 600; or set an environment variable `SECRET_ACME_API_KEY`).
4. **Dry run** — `test connector acme`. Fetches once and shows the first records as it would read them. **Nothing is saved or acted on.**
5. **Enable** — `enable connector acme`. Polling starts. The first poll only *seeds history* (records are indexed for questions but don't create tasks); after that, each new record goes through the normal pipeline.

`connectors` lists them with status and last error.

## The manifest
```json
{
  "id": "acme",
  "name": "Acme Orders",
  "description": "Open orders",
  "baseUrl": "https://api.acme.example/v1",
  "auth": { "type": "bearer", "secret": "ACME_API_KEY" },
  "poll": {
    "path": "/orders", "query": { "status": "open" }, "intervalMinutes": 15,
    "itemsPath": "data.orders", "idField": "id", "titleField": "ref",
    "bodyFields": ["status", "note"], "senderField": "customer", "timeField": "created"
  }
}
```
| Field | Notes |
|---|---|
| `auth.type` | `none`, `bearer` (`Authorization: Bearer`), `header` (custom header name in `auth.header`), `basic` (secret is `user:password`) |
| `auth.secret` | `UPPER_SNAKE_CASE` name of the credential |
| `poll.itemsPath` | dotted path to the array in the JSON response; omit if the response *is* the array |
| `idField` | stable unique id per record (de-duplication) |
| `bodyFields` | fields turned into the message text (`field: value` lines) |
| `intervalMinutes` | minimum 5 |
| field paths | letters, digits, `_ . - [ ]` only |

## Safety rules (enforced in code)
- **Read-only:** only `GET`. There is no way for a connector to write to the service.
- **HTTPS only**, no credentials in URLs, **no redirects followed**.
- **SSRF guard:** the host is resolved and refused if *any* address is private, loopback, link-local, CGNAT (incl. Tailscale `100.64/10`) or multicast — checked when proposing and again on every fetch. A connector therefore can't be pointed at your server, your NAS or cloud metadata.
- Manifest is validated (ids, secret names, field paths, interval) before it is stored; response size is capped at 2 MB and 200 records per poll.
- Three human gates: approve the design, supply the credential, say "enable" after a dry run.
- Documentation you paste or link is treated as untrusted data inside the prompt.

## Limits
Polling only (no webhooks in), one endpoint per connector, JSON only, read-only. For anything richer, add a proper adapter in `src/` (see [Development](development.md#adding-a-source)).
