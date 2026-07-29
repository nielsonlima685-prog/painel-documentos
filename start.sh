#!/usr/bin/env bash

# Atualiza o pip e instala todos os pacotes do requirements.txt dentro do .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt

# Inicia o worker facial em segundo plano
./.venv/bin/python worker_facial_final.py &

# Inicia o servidor Node.js principal
node server.js
