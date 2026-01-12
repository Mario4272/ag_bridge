# Remote Access with Tailscale

Tailscale is a private network that connects your devices securely. It allows you to access **AG Bridge** from your phone (even on LTE/5G or a different Wi-Fi) as if you were sitting right next to your computer.

## 1. Install Tailscale

1.  **On your Computer (Host)**: Download and install [Tailscale](https://tailscale.com/download).
2.  **On your Phone (Client)**: Install the Tailscale app from the App Store or Google Play.
3.  **Log in**: Sign in to the **same account** on both devices.

## 2. Check Connection

- Open the Tailscale app on your phone.
- You should see your computer in the device list with a green dot (online).

## 3. Run AG Bridge

Run the bridge with the `--remote` flag to enable Tailscale detection:

```bash
npm start
```

The console will print a **Remote URL** (e.g., `http://my-pc:8787` or `http://100.x.y.z:8787`).

## 4. Connect

Enter the **Remote URL** in your phone's browser. You should see the AG Bridge interface.
