# Host your own Jay-C server

Calls go through a small server that **one** person in the group runs on their PC: the host. It takes about 10 minutes, once. Everyone else only connects (the **Connecting** tab).

- Your PC must be on, with the server running, for anyone to call.
- Everyone's video goes through your PC, so your upload speed matters (see step 4).

## 1. Install the server

Pick one way. **Node.js is the simplest**, and it's all you need with Radmin VPN or ZeroTier.

### Option A: Node.js (recommended)

1. Install **Node.js** (the LTS version, 22 or newer) from `nodejs.org`.
2. On the Jay-C GitHub page (`github.com/TyxMatty/JayC`), click **Code › Download ZIP** and extract it to a **short** folder, for example `C:\jay-c`. Deep folders (like Downloads inside OneDrive) break the extraction, because some file paths get too long for Windows.
3. Open a terminal in the folder that has `package.json` and run, once:

```
npm install -w signaling-server
```

### Option B: Docker

Install Docker Desktop from `docker.com` and open it once. Then save the file `docker-compose.yml` from the Jay-C releases page in an empty folder, for example `C:\jay-c`.

![A PC running the Jay-C server inside Docker](/assets/setup/step1_docker.svg)

## 2. Start the server

**Node.js:** in the same folder, run the command below and **leave the terminal open**. Closing it stops the server, so run it again whenever you want to call.

```
npm run server
```

When it says `listening on 0.0.0.0:3000`, it's ready. If Windows asks whether Node.js may use the network, allow it. To update later, download the ZIP again and repeat step 1.

**Docker:** open a terminal in the folder with `docker-compose.yml` and run:

```
docker compose up -d
```

The first time, Docker downloads the server (about 400 MB). From then on it starts by itself with Docker. To update it later, run `docker compose pull` and the same command again.

![The server starting in a terminal](/assets/setup/step2_compose.svg)

## 3. Open the ports

The server uses **two ports**: `3000` (TCP) for signaling and `40000` (UDP and TCP) for audio and video. If the firewall blocks the second one, people connect but can't see or hear each other.

On Windows, open PowerShell **as administrator** on the server PC and run:

```
New-NetFirewallRule -DisplayName "Jay-C" -Direction Inbound -Protocol TCP -LocalPort 3000,40000 -Action Allow
New-NetFirewallRule -DisplayName "Jay-C media" -Direction Inbound -Protocol UDP -LocalPort 40000 -Action Allow
```

![Ports 3000 and 40000 open in the firewall](/assets/setup/step3_firewall.svg)

## 4. Find the server's address

- **Same network (home, LAN party):** on the server PC, run `ipconfig` and use the **IPv4 Address**, for example `192.168.1.50`.
- **Over the internet:** everyone joins the same virtual network with ZeroTier or Radmin VPN, and you use the server PC's address on that network. Avoid opening the ports on your router.

**Mind the upload.** All video goes through the server PC, which sends a copy to each viewer. A screen share needs about **5 Mbps of upload per viewer at 1080p30** and 7.5 Mbps at 1080p60, so 15 viewers of a 1080p60 share need about 110 Mbps. On a LAN that's easy; over the internet, the host's upload speed is the limit. Lower the share quality if people see stutters.

![Friends connecting to the server PC](/assets/setup/step4_address.svg)

## 5. Connect, and invite your friends

On this PC, open **Settings › Server** in Jay-C, enter `localhost:3000` and press **Test**. When it says "Connected", pick a room name.

Then send your friends two things: the server address from step 4 (for example `192.168.1.50:3000`) and the room name. They follow the **Connecting** tab.
