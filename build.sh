#!/bin/sh
# Wraps app.html (the page body) in a full HTML document so it can be hosted anywhere.
cd "$(dirname "$0")"
# models.js holds models/*.glb as text. It is committed, so node is only needed after changing the models.
if command -v node >/dev/null 2>&1; then node tools/pack-models.js >/dev/null; fi
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>html,body{margin:0;height:100%%}img{max-width:100%%}[hidden]{display:none!important}</style>\n</head>\n<body>\n'
  cat app.html
  printf '</body>\n</html>\n'
} > index.html
