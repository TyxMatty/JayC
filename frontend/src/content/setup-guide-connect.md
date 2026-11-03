# Join a friend's server

Someone in your group hosts the server (the **Hosting** tab). You don't install anything besides Jay-C: you only need the server's address and a room name.

## 1. Get the address

Ask the host for the server address and the room name. The address looks like `192.168.1.50:3000`.

- **Same network** (home, LAN party): that's all.
- **Over the internet:** first join the same ZeroTier or Radmin VPN network as the host, and use the address the host gives you on that network.

![Friends connecting to the server PC](/assets/setup/step4_address.svg)

## 2. Connect the app

Open **Settings › Server**, enter the address with the port and press **Test**. When it says "Connected", type the room name in the lobby and join: everyone who enters the same room name joins the same call.

![Settings › Server with a working address](/assets/setup/step5_connect.png)

## If it doesn't work

- **"No answer" or "Could not connect":** check the address with the host. The server may not be running, or the host's firewall may be blocking port `3000`.
- **You join, but can't see or hear anyone:** the host's firewall is blocking port `40000` (step 3 of the **Hosting** tab).
