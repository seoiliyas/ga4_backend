#!/bin/sh
set -e
mkdir -p "$PERSIST_DIR"

# Create tables (schema uses IF NOT EXISTS, safe on every start)
npx wrangler d1 execute gtm-chat-history --local --persist-to "$PERSIST_DIR" --file=./schema.sql

exec npx wrangler dev --local --ip 0.0.0.0 --port "$PORT" --persist-to "$PERSIST_DIR"
