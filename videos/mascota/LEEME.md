# Sebi, la mascota de sss.solutions

Robot blanco con cara de pantalla, ojos azules (#2f7cf6), antena verde WhatsApp (#25d366) y el logo en el pecho.

- `poses/`: PNG transparentes de 1000×1000 (normal, feliz, saluda, apunta, festeja, piensa).
- `bocas/`: la misma pose con cada boca (sonrisa, plano, e, a, o) y con los ojos cerrados (parpadeo). Para que "hable", alterna las bocas al ritmo de la voz (~8 por segundo).
- `perfil/`: foto de perfil para TikTok/Instagram (fondo negro).
- `animacion/sebi-transparente.webm`: 5 s con fondo transparente, para encimarlo en videos.
- `animacion/sebi-vertical.mp4`: 5 s en vertical 1080×1920.

Para nuevas poses: edita `mascota.mjs` (dibujo en SVG) y corre `node exportar.mjs` desde esta carpeta (necesita Playwright y ffmpeg).
