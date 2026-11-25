# Mac agent

`agent.sh` forwards new Messages rows to the assistant; `install.sh` sets it up as a launchd job. Full guide: [docs/mac-agent.md](../docs/mac-agent.md).

```bash
./install.sh http://<server-tailnet-name>:8090 <INGEST_TOKEN>   # then grant Full Disk Access to /bin/bash
```
