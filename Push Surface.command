#!/bin/bash
# Double-click to run NT·Push.
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then
  echo "Node.js isn't installed. Install it with:  brew install node"
  read -n 1 -p "Press any key to close."; exit 1
fi
[ -d node_modules ] || npm install
npm start
