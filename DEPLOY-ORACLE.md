# Deploy on an Oracle Cloud Always Free VM

The bot needs outbound **UDP** for Discord voice — Railway doesn't allow that, Oracle does. This runs it 24/7 for **$0**.

## 1. Create the VM (Oracle Cloud console)
1. Sign in → **Compute → Instances → Create Instance**.
2. **Image:** Canonical **Ubuntu 22.04**.
3. **Shape:** click *Change shape* → **Ampere (ARM)** → `VM.Standard.A1.Flex`, set **1 OCPU / 6 GB** (well within Always Free). *If you get an "out of capacity" error, try a different Availability Domain, or switch to the `VM.Standard.E2.1.Micro` (AMD) shape.*
4. **SSH keys:** let it generate a key pair and **download the private key** (you'll need it to log in).
5. Create. When it's running, copy the **Public IP address**.

> No firewall/ingress changes are needed — the bot only makes *outbound* connections, which Oracle allows by default.

## 2. Connect
From your computer (PowerShell works):
```bash
ssh -i path/to/your-key.key ubuntu@YOUR_PUBLIC_IP
```
(If it complains about key permissions on Windows, that's fine to ignore, or use the Oracle "Cloud Shell" button in the console instead.)

## 3. Get the code + run setup
**If the repo is public** (simplest — there are no secrets in it):
```bash
git clone https://github.com/mishr4/TMCBot.git
cd TMCBot
bash setup.sh
```

**If you keep it private**, set up a read-only deploy key first:
```bash
ssh-keygen -t ed25519 -C tmcbot -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
Copy that line → GitHub → the **TMCBot** repo → **Settings → Deploy keys → Add deploy key** → paste → save. Then:
```bash
git clone git@github.com:mishr4/TMCBot.git
cd TMCBot
bash setup.sh
```

## 4. Fill in your token
The first `setup.sh` run creates a `.env` and stops. Edit it:
```bash
nano .env
```
Set at least:
- `DISCORD_TOKEN=` your bot token
- `GUILD_ID=` your server ID (so slash commands appear instantly)
- `TMCAST_STREAM_URL=` already set to Mavion Radio One — change the slug if needed
- *(optional)* `AUTOPLAY_CHANNEL_ID=` a voice channel ID to auto-join 24/7

Save (Ctrl+O, Enter, Ctrl+X), then run setup again to start it:
```bash
bash setup.sh
```

## 5. Verify
```bash
sudo journalctl -u tmcbot -f
```
You should see `Logged in as TMCBot#4335`. Hop in a voice channel and run **/play** — this time the voice connection will complete and the radio will stream.

### Handy commands
| Action | Command |
|---|---|
| Live logs | `sudo journalctl -u tmcbot -f` |
| Restart | `sudo systemctl restart tmcbot` |
| Stop | `sudo systemctl stop tmcbot` |
| Update to latest code | `git pull && npm install --omit=dev && sudo systemctl restart tmcbot` |
