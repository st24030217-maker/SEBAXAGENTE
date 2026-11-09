FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# La base de datos y la sesión de WhatsApp viven en /app/data:
# en Render se monta ahí un disco persistente (ver render.yaml); con Docker, usa un volumen.
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
