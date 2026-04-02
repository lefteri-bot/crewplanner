const { spawn, exec } = require("child_process");
const path = require("path");

const server = spawn(process.execPath, [path.join(__dirname, "backend", "server.js")], {
  stdio: "inherit",
  env: process.env
});

// Open the admin shortcut by default (desktop). Crew devices should use /crew.
const url = "http://localhost:3000/admin";

function openBrowser(u) {
  const platform = process.platform;
  if (platform === "win32") exec(`start "" "${u}"`);
  else if (platform === "darwin") exec(`open "${u}"`);
  else exec(`xdg-open "${u}"`);
}

// Open browser after a short delay
setTimeout(() => openBrowser(url), 1200);

process.on("SIGINT", () => {
  server.kill("SIGINT");
  process.exit(0);
});
