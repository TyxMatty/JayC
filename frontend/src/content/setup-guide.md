# Host your own Jay-C server

Calls go through a small server that **one** person in the group runs, usually on their PC. There are two roles:

- **Hosting** (one person): installs and runs the server, steps 1 to 4. It takes about 10 minutes, once. That PC must be on, with the server running, for anyone to call, and its upload speed is what everyone's video goes through.
- **Only connecting** (everyone else): nothing to install besides Jay-C. Ask the host for the server's address, for example `192.168.1.50:3000`, and do step 5 only.

The host connects the same way, with step 5 on their own PC (`localhost:3000` works there).

## 1. Install Docker Desktop

Download Docker Desktop from `docker.com`, install it and open it once. Docker runs the Jay-C server in a box (a container), so you don't install anything else.

![A PC running the Jay-C server inside Docker](/assets/setup/step1_docker.svg)

## 2. Start the server

Create an empty folder, for example `C:\jay-c`, and save the file `docker-compose.yml` from the Jay-C releases page in it. Then open a terminal in that folder and run:

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

## 5. Connect the app

In Jay-C, open **Settings › Server**, enter the address with the port, for example `192.168.1.50:3000`, and press **Test**. When it says "Connected", pick a room name and share it with your friends: everyone who enters the same room joins the same call.

![Settings › Server with a working address](/assets/setup/step5_connect.png)
