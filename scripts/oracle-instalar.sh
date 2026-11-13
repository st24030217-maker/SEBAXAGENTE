#!/usr/bin/env bash
# Instala el agente en un servidor Ubuntu (por ejemplo, Oracle Cloud "Always Free").
# Uso (en el servidor, por SSH):
#   curl -fsSL https://raw.githubusercontent.com/st24030217-maker/SEBAXAGENTE/main/scripts/oracle-instalar.sh | sudo DOMINIO=tunombre.duckdns.org bash
# DOMINIO es opcional: si lo pones, se configura HTTPS con Caddy para abrir el panel desde internet.
# Se puede volver a correr sin problema: no borra datos ni el .env.
set -euo pipefail

REPO="https://github.com/st24030217-maker/SEBAXAGENTE.git"
DIR="/opt/sebaxagente"
USUARIO="sebax"
PUERTO=3000
DOMINIO="${DOMINIO:-}"

[ "$(id -u)" = 0 ] || { echo "Córrelo con sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/7 Paquetes del sistema"
apt-get update -y
apt-get install -y ca-certificates curl git gnupg nano iptables-persistent

echo "== 2/7 Memoria extra (swap) para servidores chicos"
if ! swapon --show | grep -q /swapfile && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 4000 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "== 3/7 Node.js 22"
if ! node -v 2>/dev/null | grep -q "^v22"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== 4/7 Código del agente"
id "$USUARIO" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USUARIO"
if [ -d "$DIR/.git" ]; then
  sudo -u "$USUARIO" git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
  chown -R "$USUARIO:$USUARIO" "$DIR"
fi
sudo -u "$USUARIO" bash -c "cd '$DIR' && npm ci --omit=dev"

echo "== 5/7 Claves (.env)"
if [ ! -f "$DIR/.env" ]; then
  cat > "$DIR/.env" <<EOF
# Copia aquí los valores que tienes en Render (Environment). No compartas este archivo.
PORT=$PUERTO
PUBLIC_URL=${DOMINIO:+https://$DOMINIO}
ADMIN_TOKEN=
ADMIN_ABIERTO=true
ADMIN_SIN_TOKEN_EN_RED_LOCAL=false
IA_PROVEEDOR=auto
GEMINI_API_KEY=
GEMINI_MODELO=gemini-3.5-flash
ANTHROPIC_API_KEY=
AGENTE_MODELO=claude-sonnet-5-5
PROSPECCION_MODELO=
AGENTE_ESFUERZO=
WA_NUMERO=
DENUE_TOKEN=
TELEGRAM_MODE=
PAYMENT_PROVIDER=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
MANTENER_DESPIERTO=false
EOF
  chown "$USUARIO:$USUARIO" "$DIR/.env"
  chmod 600 "$DIR/.env"
  echo ">> Se abrirá el editor: pega tus claves de Render, guarda con Ctrl+O, Enter, y sal con Ctrl+X."
  read -r -p "Presiona Enter para abrir el editor..." _ </dev/tty || true
  nano "$DIR/.env" </dev/tty >/dev/tty
fi

echo "== 6/7 Servicio (arranca solo y se reinicia si falla)"
cat > /etc/systemd/system/sebaxagente.service <<EOF
[Unit]
Description=Agente Sebax
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
EOF

# Auto-actualización: cada 5 min revisa GitHub; si hay cambios en main, los baja y reinicia (como Render).
cat > /usr/local/bin/sebaxagente-actualizar <<EOF
#!/usr/bin/env bash
set -e
cd $DIR
sudo -u $USUARIO git fetch -q origin main
if [ "\$(sudo -u $USUARIO git rev-parse HEAD)" != "\$(sudo -u $USUARIO git rev-parse origin/main)" ]; then
  sudo -u $USUARIO git reset -q --hard origin/main
  sudo -u $USUARIO npm ci --omit=dev --silent
  systemctl restart sebaxagente
  echo "Actualizado a \$(sudo -u $USUARIO git rev-parse --short HEAD)"
fi
EOF
chmod +x /usr/local/bin/sebaxagente-actualizar
cat > /etc/systemd/system/sebaxagente-actualizar.service <<EOF
[Unit]
Description=Actualiza el agente desde GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/sebaxagente-actualizar
EOF
cat > /etc/systemd/system/sebaxagente-actualizar.timer <<EOF
[Unit]
Description=Revisa GitHub cada 5 minutos
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now sebaxagente sebaxagente-actualizar.timer
systemctl restart sebaxagente

echo "== 7/7 Acceso desde internet"
if [ -n "$DOMINIO" ]; then
  # Las imágenes Ubuntu de Oracle bloquean todo menos SSH en el firewall interno.
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $p -j ACCEPT
  done
  netfilter-persistent save
  if ! command -v caddy >/dev/null; then
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
  fi
  printf '%s {\n  reverse_proxy localhost:%s\n}\n' "$DOMINIO" "$PUERTO" > /etc/caddy/Caddyfile
  systemctl restart caddy
  echo ">> Panel: https://$DOMINIO/admin  (abre los puertos 80 y 443 en la 'Security List' de Oracle)"
else
  echo ">> Sin DOMINIO: el panel solo se abre por túnel SSH:  ssh -L 3000:localhost:3000 ubuntu@IP  y luego http://localhost:3000/admin"
fi

sleep 8
systemctl --no-pager --lines=15 status sebaxagente || true
echo
echo "Listo. Ver registros en vivo:  sudo journalctl -u sebaxagente -f"
