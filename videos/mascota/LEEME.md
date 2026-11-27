# Sebi, la mascota de sss.solutions (pixel art)

Robot en pixel art (sprite de 48×48) con cara de pantalla, ojos azules (#2f7cf6) y la "S" de la marca en el pecho.

- `poses/`: PNG transparentes de 960×960 (normal, feliz, saluda, apunta, festeja, piensa).
- `bocas/`: la misma pose con cada boca (sonrisa, plano, e, a, o) y parpadeando. Para que "hable", alterna las bocas al ritmo de la voz (~10 por segundo).
- `perfil/perfil-tiktok.png`: foto de perfil con fondo negro. `perfil/sprite-48px.png`: el sprite a tamaño real.
- `animacion/sebi-transparente.webm`: 6 s con fondo transparente (30 fps), para encimarlo en videos.
- `animacion/sebi-vertical.mp4`: 6 s en vertical 1080×1920.

Para nuevas poses o cambios: edita `sebi-pixel.mjs` y corre `node sebi-pixel.mjs .` desde esta carpeta (solo necesita ffmpeg).
