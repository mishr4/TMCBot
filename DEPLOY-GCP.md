# Deploy on a Google Cloud free `e2-micro` VM

GCP's Always Free tier includes one `e2-micro` VM running 24/7, and (unlike Railway) it allows the outbound UDP that Discord voice needs.

> ⚠️ **About "free" + bandwidth:** the VM itself is free, but streaming audio uses outbound bandwidth, and GCP includes only **1 GB/month free egress**. So:
> - **On-demand** (bot plays only while staff are listening, then `/stop`): stays roughly free.
> - **24/7 streaming** (always in a channel): ~30 GB/month → about **$3–4/month** in egress.
>
> To cut it, set `AUDIO_BITRATE=64k` in `.env` (saves ~⅓). If you truly want always-on 24/7, a flat-rate VPS with included bandwidth (your Spaceship Starlight, or Hetzner ~€4) is more predictable — just say the word and I'll point you there instead.

## 1. Create the VM
1. https://console.cloud.google.com → **Compute Engine → VM instances → Create instance** (enable the Compute Engine API if it asks).
2. **Name:** `tmcbot`
3. **Region:** must be **`us-west1`**, **`us-central1`**, or **`us-east1`** — only these are free-tier eligible.
4. **Machine configuration:** series **E2**, machine type **`e2-micro`** (this exact shape is the free one).
5. **Boot disk:** Change → **Ubuntu 22.04 LTS**, **30 GB Standard** disk (free-tier limits).
6. Leave the firewall boxes unchecked (the bot needs no inbound). Click **Create**.

## 2. Connect (no keys needed)
On the instance row, click **SSH → Open in browser window**. That opens a terminal right in your browser.

## 3. Deploy
Paste this into that SSH window:
```bash
git clone https://github.com/mishr4/TMCBot.git
cd TMCBot
bash setup.sh        # installs Node + deps, creates .env, then stops
nano .env            # paste DISCORD_TOKEN + GUILD_ID; save with Ctrl+O, Enter, Ctrl+X
bash setup.sh        # starts it as a 24/7 service
```

## 4. Verify
```bash
sudo journalctl -u tmcbot -f
```
You should see `Logged in as TMCBot#4335`. Hop in a voice channel and run **/play** — it connects and streams.

### Handy commands
| Action | Command |
|---|---|
| Live logs | `sudo journalctl -u tmcbot -f` |
| Restart | `sudo systemctl restart tmcbot` |
| Stop | `sudo systemctl stop tmcbot` |
| Update to latest | `git pull && npm install --omit=dev && sudo systemctl restart tmcbot` |
