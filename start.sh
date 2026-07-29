#!/usr/bin/env bash

# Força a instalação usando o pip de dentro do ambiente virtual do Render
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt

# Inicia o worker facial usando o python do ambiente virtual em segundo plano
./.venv/bin/python worker_facial_final.py &

# Inicia o servidor Node.js principal
node server.js
