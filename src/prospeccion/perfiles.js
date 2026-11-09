// Perfiles de negocio para los bocetos: qué muestra se le arma a cada tipo de negocio.
// Cada negocio se reconoce por su NOMBRE y por su GIRO del DENUE (no solo por el rubro con que se buscó),
// así "Monster Burgers" recibe un menú de hamburguesas aunque haya salido buscando "restaurante".
//
// Campos:  id, nombre (para la galería), tipo (menu | cafe | catalogo | citas | fidelidad | inmobiliaria |
//          escuela | servicios), color, que (qué se le ofrece), n (regex sobre el nombre), g (regex sobre el
//          giro), fuerte (el giro manda sobre el nombre: salud, autos, profesiones...), rubros (respaldo por
//          rubro de la config), ia (muestra el asistente de IA), accion (texto del botón principal).
//          Contenido: cats {categoría: [[nombre, descripción, precio]]}, items [[nombre, desc, precio]],
//          servicios [[nombre, minutos, precio]], planes [[nombre, desc, precio]], sellos {total, llevas, premio}.

const S = (total, llevas, premio, palabraSello) => ({ sellos: { total, llevas, premio }, ...(palabraSello ? { palabraSello } : {}) });

export const PERFILES = [
  // ---------- Autos (el giro manda: "Auto Spa" es un lavado, no un spa) ----------
  { id: "lavado", nombre: "Lavado de autos", tipo: "fidelidad", color: "#1c7ed6", que: "tarjeta de fidelidad digital", fuerte: true,
    g: /lavado y lubricado/, n: /lavado|autolavado|car ?wash|auto ?spa|detallado|autobano/, rubros: ["Lavados de autos"],
    ...S(5, 4, "un lavado gratis", "lavados"),
    planes: [["Lavado exterior", "Carrocería y rines", 120], ["Lavado completo", "Por dentro y por fuera", 180], ["Encerado", "Brillo y protección", 350], ["Lavado de vestiduras", "Asientos y alfombras", 700]] },
  { id: "taller", nombre: "Taller mecánico", tipo: "citas", color: "#495057", que: "página con citas y un asistente que cotiza por WhatsApp", fuerte: true, ia: true,
    g: /reparacion mecanica|sistema electrico de autom|hojalateria|transmision|suspension|alineacion|reparaciones mecanicas de autom|reparacion y mantenimiento de motocicl/, n: /taller|mecanic|automotr|afinacion|frenos|hojalat|transmision|motos?\b/, rubros: ["Talleres mecánicos"],
    servicios: [["Diagnóstico por computadora", 30, 350], ["Afinación mayor", 120, 1200], ["Cambio de aceite y filtro", 45, 650], ["Frenos (balatas y rectificado)", 90, 900]] },
  { id: "llantera", nombre: "Llantera", tipo: "citas", color: "#343a40", que: "página con citas por WhatsApp", fuerte: true,
    g: /llantas y camaras/, n: /llant|vulcaniz/,
    servicios: [["Alineación y balanceo", 60, 450], ["Reparación de ponchadura", 20, 120], ["Rotación de llantas", 30, 200], ["Montaje de llantas nuevas", 45, 300]] },
  { id: "refaccionaria", nombre: "Refaccionaria", tipo: "catalogo", color: "#868e96", que: "catálogo con cotizaciones por WhatsApp", fuerte: true,
    g: /partes y refacciones/, n: /refacc|autopartes|autoparte/, rubros: ["Refaccionarias"],
    items: [["Balatas delanteras", "Para la mayoría de modelos", 450], ["Filtro de aceite", "Original o equivalente", 120], ["Aceite sintético", "4 litros", 650], ["Batería", "Con garantía", 2100], ["Juego de bujías", "4 piezas", 320], ["Amortiguador", "Delantero o trasero", 890]] },

  // ---------- Salud (el giro manda) ----------
  { id: "dentista", nombre: "Dentista", tipo: "citas", color: "#1971c2", que: "agenda en línea con asistente de IA", fuerte: true, ia: true,
    g: /consultorios dentales/, n: /dental|dentist|odont|ortodon|sonrisa/, rubros: ["Dentistas"],
    servicios: [["Valoración", 30, 0], ["Limpieza dental", 45, 600], ["Resina", 60, 800], ["Blanqueamiento", 90, 2500]] },
  { id: "veterinaria", nombre: "Veterinaria", tipo: "citas", color: "#2b8a3e", que: "app para agendar citas con recordatorios de vacunas", fuerte: true,
    g: /servicios veterinarios/, n: /veterin|vet\b|mascotas? clinic/, rubros: ["Veterinarias"],
    servicios: [["Consulta", 30, 350], ["Vacuna", 15, 300], ["Baño y corte", 90, 400], ["Desparasitación", 15, 200]], ...S(6, 2, "un baño gratis") },
  { id: "laboratorio", nombre: "Laboratorio clínico", tipo: "citas", color: "#0ca678", que: "página con citas y resultados por WhatsApp", fuerte: true,
    g: /laboratorios medicos/, n: /laboratorio clinic|analisis clinic|lab\. clinic/,
    servicios: [["Química sanguínea (6 elementos)", 15, 250], ["Biometría hemática", 15, 180], ["Perfil tiroideo", 15, 450], ["Examen general de orina", 10, 120]] },
  { id: "optica", nombre: "Óptica", tipo: "citas", color: "#1c7ed6", que: "página con citas para examen de la vista y catálogo", fuerte: true,
    g: /al por menor de lentes/, n: /optic|optom|lentes/, rubros: ["Ópticas"],
    servicios: [["Examen de la vista", 30, 0], ["Lentes monofocales", 30, 1200], ["Lentes de contacto", 30, 900], ["Ajuste y limpieza", 15, 0]] },
  { id: "farmacia", nombre: "Farmacia", tipo: "catalogo", color: "#2b8a3e", que: "catálogo con pedidos a domicilio por WhatsApp", fuerte: true,
    g: /farmacias/, n: /farmac|botica/, rubros: ["Farmacias"],
    items: [["Paracetamol 500 mg", "20 tabletas", 35], ["Vitamina C", "Frasco con 100", 89], ["Suero oral", "625 ml", 25], ["Termómetro digital", "Lectura en 10 s", 120], ["Cubrebocas", "Caja con 50", 79], ["Bloqueador solar", "FPS 50", 189]] },
  { id: "fisio", nombre: "Fisioterapia", tipo: "citas", color: "#1098ad", que: "agenda en línea con recordatorios", fuerte: true,
    g: /fisioterap|terapia ocupacional|audiologia/, n: /fisio|rehabilit|quiropr/, rubros: ["Fisioterapia"],
    servicios: [["Valoración", 45, 400], ["Sesión de fisioterapia", 60, 450], ["Masaje terapéutico", 50, 500], ["Paquete de 10 sesiones", 60, 3900]] },
  { id: "psicologo", nombre: "Psicólogo", tipo: "citas", color: "#6741d9", que: "agenda en línea discreta y con recordatorios", fuerte: true,
    g: /consultorios de psicologia/, n: /psicolog|terapia|tanatolog/,
    servicios: [["Primera consulta", 60, 600], ["Terapia individual", 50, 550], ["Terapia de pareja", 60, 750], ["Terapia en línea", 50, 500]] },
  { id: "nutriologo", nombre: "Nutriólogo", tipo: "citas", color: "#37b24d", que: "agenda en línea con seguimiento por WhatsApp", fuerte: true,
    g: /nutriologos|dietistas/, n: /nutri|dieta/,
    servicios: [["Consulta inicial", 60, 500], ["Seguimiento", 30, 350], ["Plan de alimentación", 45, 450], ["Bioimpedancia", 15, 200]] },
  { id: "consultorio", nombre: "Consultorio médico", tipo: "citas", color: "#0c8599", que: "página con agenda en línea", fuerte: true,
    g: /consultorios de medicina|consultorios medicos|clinicas de consultorios|hospitales/, n: /consultorio|medic[oa]|doctor|dra?\.|pediatr|ginec|cardiol|dermatol/, rubros: ["Consultorios"],
    servicios: [["Consulta general", 30, 400], ["Consulta de seguimiento", 20, 300], ["Certificado médico", 15, 250]] },
  { id: "guarderia", nombre: "Guardería", tipo: "escuela", color: "#f06595", que: "página con informes e inscripciones en línea", fuerte: true,
    g: /guarderias/, n: /guarder|estancia infantil|kinder|preescol|maternal/, rubros: ["Guarderías"],
    items: [["Lactantes", "De 45 días a 1 año · horario extendido"], ["Maternal", "De 1 a 3 años · estimulación temprana"], ["Preescolar", "De 3 a 6 años · inglés y actividades"]] },

  // ---------- Profesiones y servicios (el giro manda) ----------
  { id: "abogado", nombre: "Abogados", tipo: "servicios", color: "#1864ab", que: "página profesional con citas y asistente de IA", fuerte: true, ia: true,
    g: /bufetes juridicos|notarias/, n: /abogad|juridic|notari|legal|despacho/, rubros: ["Abogados"],
    items: [["Asesoría inicial", "Te orientamos sobre tu caso"], ["Divorcios y familiar", "Pensión, custodia y convenios"], ["Laboral", "Despidos, demandas y finiquitos"], ["Contratos y trámites", "Compraventa, arrendamiento y poderes"]] },
  { id: "contador", nombre: "Contadores", tipo: "servicios", color: "#2b8a3e", que: "página profesional con citas y asistente de IA", fuerte: true, ia: true,
    g: /contabilidad y auditoria/, n: /contab|contador|fiscal|impuest|nomina/, rubros: ["Contadores"],
    items: [["Declaraciones", "Mensuales y anuales, personas y empresas"], ["Facturación", "Emisión y control de CFDI"], ["Nómina e IMSS", "Altas, bajas y cálculo de cuotas"], ["Alta en el SAT", "RFC, e.firma y régimen correcto"]] },
  { id: "seguros", nombre: "Agente de seguros", tipo: "servicios", color: "#364fc7", que: "página con cotizador y asistente de IA", fuerte: true, ia: true,
    g: /seguros y fianzas|gestores de seguros/, n: /seguro|fianza/, rubros: ["Seguros"],
    items: [["Seguro de auto", "Cobertura amplia o limitada"], ["Gastos médicos", "Individual o familiar"], ["Vida", "Protege a los tuyos"], ["Negocio", "Daños, robo y responsabilidad civil"]] },
  { id: "viajes", nombre: "Agencia de viajes", tipo: "servicios", color: "#1c7ed6", que: "página con paquetes y cotizaciones por WhatsApp", fuerte: true,
    g: /agencias de viajes/, n: /viaje|turism|tours?\b/, rubros: ["Agencias de viajes"],
    items: [["Paquetes a la playa", "Mazatlán, Cancún, Vallarta"], ["Vuelos", "Nacionales e internacionales"], ["Excursiones", "Salidas en grupo cada mes"], ["Viajes de graduación", "Planes a meses sin intereses"]] },
  { id: "lavanderia", nombre: "Lavandería", tipo: "fidelidad", color: "#339af0", que: "tarjeta de fidelidad y pedidos por WhatsApp", fuerte: true,
    g: /lavanderias y tintorerias/, n: /lavander|tintorer/, rubros: ["Lavanderías"],
    ...S(8, 5, "un servicio gratis", "servicios"),
    planes: [["Lavado por kilo", "Lavado, secado y doblado", "$25 / kg"], ["Edredón", "Matrimonial o king size", 120], ["Planchado", "Docena de prendas", 150], ["Recolección a domicilio", "Pregunta por tu zona", 0]] },
  { id: "fotografia", nombre: "Fotografía", tipo: "servicios", color: "#212529", que: "portafolio en línea con cotizaciones", fuerte: true,
    g: /fotografia y videograbacion/, n: /foto|video|filmac/, rubros: ["Fotografía"],
    items: [["XV años", "Sesión previa, evento y video"], ["Bodas", "Cobertura completa y álbum"], ["Sesión familiar", "En exterior o estudio"], ["Fotografía de producto", "Para tu tienda en línea"]] },
  { id: "eventos", nombre: "Salón de eventos", tipo: "servicios", color: "#d6336c", que: "página con fechas disponibles y cotizaciones", fuerte: true,
    g: /salones para fiestas|mesas, sillas, vajillas/, n: /salon de (eventos|fiestas)|jardin de eventos|banquet|eventos|fiestas|inflable/, rubros: ["Salones de eventos"],
    items: [["Paquete XV años", "Salón, banquete y DJ"], ["Bodas", "Hasta 300 invitados"], ["Fiestas infantiles", "Inflables y show"], ["Renta de mobiliario", "Mesas, sillas y mantelería"]] },
  { id: "hotel", nombre: "Hotel", tipo: "catalogo", color: "#0b7285", que: "página con reservas directas, sin comisiones", fuerte: true, accion: "Reservar",
    g: /hoteles|moteles|hospedaje/, n: /hotel|motel|hostal|posada|suites/, rubros: ["Hoteles"],
    items: [["Habitación sencilla", "1 cama matrimonial", "$650 / noche"], ["Habitación doble", "2 camas matrimoniales", "$850 / noche"], ["Suite", "Cama king y sala", "$1,400 / noche"], ["Estancia larga", "Semana o mes", "Pregunta"]] },
  { id: "imprenta", nombre: "Imprenta", tipo: "servicios", color: "#f76707", que: "página con cotizaciones por WhatsApp", fuerte: true,
    g: /impresion de|diseno grafico|serigrafia|anuncios publicitarios/, n: /imprent|serigraf|rotul|publicid|lona|letrero|impresion/, rubros: ["Imprentas"],
    items: [["Lonas y viniles", "Impresión en gran formato"], ["Tarjetas de presentación", "Desde 100 piezas"], ["Playeras estampadas", "Para tu negocio o evento"], ["Rótulos y anuncios", "Diseño e instalación"]] },
  { id: "inmobiliaria", nombre: "Inmobiliaria", tipo: "inmobiliaria", color: "#087f5b", que: "página de propiedades con asistente de IA", fuerte: true, ia: true,
    g: /inmobiliarias y corredores/, n: /inmobili|bienes raices|real estate|propiedades/, rubros: ["Inmobiliarias"],
    items: [["Casa en venta", "3 recámaras · 2 baños · cochera doble", "$2,450,000"], ["Departamento en renta", "2 recámaras · 1 baño · amueblado", "$9,500 al mes"], ["Terreno", "300 m² · uso habitacional", "$850,000"], ["Local comercial", "80 m² · sobre avenida", "$15,000 al mes"]] },
  { id: "gimnasio", nombre: "Gimnasio", tipo: "fidelidad", color: "#e03131", que: "membresías con tarjeta en el celular", fuerte: true,
    g: /acondicionamiento fisico/, n: /gimnas|\bgym|crossfit|fitness|\byoga|pilates|zumba|\bbox(eo)?\b|artes marciales|karate|\bdanza/, rubros: ["Gimnasios"],
    ...S(12, 9, "una semana gratis", "asistencias"),
    planes: [["Visita", "Un día", 50], ["Mensualidad", "Acceso ilimitado", 450], ["Trimestre", "Ahorra 150", 1200]] },
  { id: "escuela", nombre: "Escuela o academia", tipo: "escuela", color: "#4c6ef5", que: "plataforma con inscripciones en línea", fuerte: true,
    g: /escuelas|educacion|ensenanza/, n: /escuela|colegio|academ|instituto|idioma|ingles|regulariz|clases/, rubros: ["Escuelas y academias"],
    items: [["Inglés", "Niños, jóvenes y adultos · sabatino o entre semana"], ["Regularización", "Primaria y secundaria · grupos reducidos"], ["Computación", "Office, internet y mecanografía"]] },

  // ---------- Comercio (el giro manda) ----------
  { id: "ferreteria", nombre: "Ferretería", tipo: "catalogo", color: "#f08c00", que: "catálogo con cotizaciones por WhatsApp", fuerte: true,
    g: /ferreterias y tlapalerias|materiales para la construccion|pintura/, n: /ferret|tlapal|material(es)? para|pintur/, rubros: ["Ferreterías"],
    items: [["Taladro inalámbrico", "20 V con 2 baterías", 1299], ["Juego de desarmadores", "12 piezas", 189], ["Pintura vinílica", "Cubeta 19 L", 1450], ["Cinta de aislar", "Rollo 18 m", 25], ["Escalera de tijera", "6 escalones", 1150], ["Brocha", "3 pulgadas", 65]] },
  { id: "papeleria", nombre: "Papelería", tipo: "catalogo", color: "#fab005", que: "catálogo con pedidos y listas escolares por WhatsApp", fuerte: true,
    g: /articulos de papeleria/, n: /papeler|copias|regalos|novedades/, rubros: ["Papelerías"],
    items: [["Lista escolar completa", "Mándanos tu lista y te la armamos", 0], ["Cuadernos profesionales", "Paquete de 5", 145], ["Impresión a color", "Por hoja", 5], ["Engargolado", "Hasta 100 hojas", 35], ["Mochila", "Varios modelos", 399], ["Envoltura de regalo", "Con moño", 30]] },
  { id: "joyeria", nombre: "Joyería", tipo: "catalogo", color: "#ae3ec9", que: "catálogo en línea con apartado por WhatsApp", fuerte: true,
    g: /articulos de joyeria|relojes/, n: /joyer|relojer/, rubros: ["Joyerías"],
    items: [["Anillo de compromiso", "Oro 14k con zirconia", 4500], ["Cadena de oro", "10k · 50 cm", 3200], ["Arracadas", "Plata .925", 450], ["Reloj", "Acero inoxidable", 1800], ["Esclava", "Con grabado", 950], ["Grabado", "En cualquier pieza", 0]] },
  { id: "zapateria", nombre: "Zapatería", tipo: "catalogo", color: "#c2255c", que: "catálogo en línea con apartado por WhatsApp", fuerte: true,
    g: /al por menor de calzado/, n: /zapat|calzado|tenis|botas/, rubros: ["Zapaterías"],
    items: [["Tenis deportivos", "Del 22 al 30", 899], ["Botas vaqueras", "Piel genuina", 1450], ["Zapato de vestir", "Caballero", 799], ["Sandalias", "Dama", 399], ["Tenis escolares", "Negros o blancos", 549], ["Zapatillas", "Tacón 7 cm", 699]] },
  { id: "muebleria", nombre: "Mueblería", tipo: "catalogo", color: "#9c6644", que: "catálogo en línea con apartado y pagos", fuerte: true,
    g: /muebles para el hogar|colchones/, n: /muebl|colchon|decoraci/, rubros: ["Mueblerías"],
    items: [["Sala de 3 piezas", "Tela antimanchas", 12900], ["Comedor de 6 sillas", "Madera", 9500], ["Colchón matrimonial", "Ortopédico", 4800], ["Ropero", "3 puertas", 3900], ["Escritorio", "Con cajonera", 2200], ["Base de cama", "Matrimonial", 2600]] },
  { id: "celulares", nombre: "Celulares y reparación", tipo: "catalogo", color: "#364fc7", que: "catálogo y reparaciones con seguimiento por WhatsApp", fuerte: true,
    g: /telefonos y otros aparatos de comunicacion|reparacion y mantenimiento de otro equipo electronico|computadoras/, n: /celular|cel\b|movil|telcel|reparacion de equipo|computa|laptop|gadget/, rubros: ["Celulares"],
    items: [["Cambio de pantalla", "Varios modelos, con garantía", 1200], ["Cambio de batería", "En 1 hora", 650], ["Diagnóstico", "Sin compromiso", 0], ["Funda", "Antigolpes", 199], ["Mica de cristal", "Instalada", 99], ["Cargador rápido", "Con cable", 249]] },
  { id: "mascotas", nombre: "Tienda de mascotas", tipo: "catalogo", color: "#f76707", que: "catálogo con pedidos a domicilio y tarjeta de cliente frecuente", fuerte: true,
    g: /al por menor de mascotas|alimento para mascotas/, n: /\bpet\b|pets|mascota|croquet|forraj/, rubros: ["Tiendas de mascotas"],
    items: [["Croquetas", "Bulto de 20 kg", 899], ["Arena para gato", "10 kg", 159], ["Collar", "Varias tallas", 149], ["Cama", "Tamaño mediano", 459], ["Juguetes", "Desde", 89], ["Shampoo", "Antipulgas", 129]], ...S(10, 6, "un bulto con descuento", "compras") },
  { id: "floreria", nombre: "Florería", tipo: "catalogo", color: "#e64980", que: "catálogo con pedidos por WhatsApp", fuerte: true,
    g: /plantas y flores/, n: /flor(eria|es|ista)|vivero|rosas/, rubros: ["Florerías"],
    items: [["Ramo de 12 rosas", "Rojas, blancas o rosas", 650], ["Arreglo primaveral", "Flores de temporada", 480], ["Ramo de girasoles", "6 girasoles", 420], ["Orquídea en maceta", "Blanca o morada", 550], ["Caja de rosas", "24 rosas", 890], ["Flores con globo", "Para cumpleaños", 520]] },
  { id: "boutique", nombre: "Boutique y ropa", tipo: "catalogo", color: "#d6336c", que: "catálogo en línea", fuerte: true,
    g: /al por menor de ropa|bisuteria|accesorios de vestir|uniformes/, n: /boutique|ropa|moda|fashion|uniform|bazar/, rubros: ["Tiendas y boutiques"],
    items: [["Blusa de lino", "Tallas CH a G", 349], ["Vestido casual", "Varios colores", 599], ["Jeans corte recto", "Tallas 3 a 15", 499], ["Bolsa de mano", "Piel sintética", 450], ["Sandalias", "Del 22 al 26", 399], ["Accesorios", "Aretes, collares y pulseras", 149]] },
  { id: "construccion", nombre: "Construcción y oficios", tipo: "servicios", color: "#5c940d", que: "página con portafolio y cotizaciones por WhatsApp", fuerte: true,
    g: /construccion|herreria|carpinteria|vidrio|aluminio|instalaciones electricas|plomeria|aire acondicionado|cerrajeria|fumigacion|limpieza/, n: /constru|arquitect|remodel|herrer|carpint|aluminio|vidrio|plomer|electric|clima|refrigera|cerraj|fumig|limpieza|jardiner/,
    items: [["Presupuesto sin costo", "Vamos a tu domicilio"], ["Instalación", "Con garantía por escrito"], ["Mantenimiento", "Preventivo y correctivo"], ["Urgencias", "Atención el mismo día"]] },

  // ---------- Belleza (el nombre afina: el giro del DENUE es el mismo para todos) ----------
  { id: "barberia", nombre: "Barbería", tipo: "citas", color: "#b08900", que: "app para agendar citas con tarjeta de fidelidad",
    n: /barber|barbershop|barba/, rubros: ["Barberías"],
    servicios: [["Corte clásico", 30, 150], ["Corte y barba", 50, 230], ["Arreglo de barba", 25, 120], ["Corte de niño", 30, 120]], ...S(5, 3, "un corte gratis") },
  { id: "unas", nombre: "Uñas", tipo: "citas", color: "#e64980", que: "app para agendar citas con tarjeta de fidelidad",
    n: /\bunas\b|nails?\b|manicur|gelish|acrilic/,
    servicios: [["Gelish en manos", 45, 200], ["Uñas acrílicas", 90, 350], ["Pedicure spa", 60, 280], ["Retiro", 20, 80]], ...S(6, 3, "un gelish gratis") },
  { id: "spa", nombre: "Spa y masajes", tipo: "citas", color: "#7048e8", que: "app para agendar citas con paquetes y regalos",
    n: /\bspa\b|masaj|relaj|facial|depilac|cosmetolog/, rubros: ["Spas"],
    servicios: [["Masaje relajante", 60, 450], ["Facial profundo", 60, 500], ["Depilación láser (zona chica)", 30, 350], ["Paquete spa", 120, 990]] },
  { id: "tatuajes", nombre: "Tatuajes", tipo: "citas", color: "#212529", que: "portafolio y agenda de citas en línea",
    n: /tatu|tattoo|ink\b|pierc/,
    servicios: [["Valoración y diseño", 30, 0], ["Tatuaje chico", 60, 800], ["Sesión de 3 horas", 180, 2500], ["Perforación", 20, 350]] },
  { id: "estetica", nombre: "Estética y salón", tipo: "citas", color: "#9c36b5", que: "app para agendar citas con tarjeta de fidelidad",
    g: /salones y clinicas de belleza/, n: /estetic|salon|belleza|beauty|peluquer|cabello|hair|maquillaje|look/, rubros: ["Estéticas y salones"],
    servicios: [["Corte y peinado", 60, 250], ["Tinte", 120, 650], ["Manicure", 45, 200], ["Pedicure", 60, 250], ["Extensión de pestañas", 90, 450]], ...S(6, 4, "un manicure gratis") },

  // ---------- Comida (el nombre manda: el giro del DENUE mezcla pizzas, hamburguesas y pollos) ----------
  { id: "pizzeria", nombre: "Pizzería", tipo: "menu", color: "#c92a2a", que: "menú digital con pedidos y asistente de IA", ia: true,
    n: /pizz/, rubros: ["Pizzerías"],
    cats: { Pizzas: [["Pepperoni", "Grande, 8 rebanadas", 199], ["Hawaiana", "Grande, 8 rebanadas", 209], ["Mexicana", "Chorizo, jalapeño y cebolla", 229]], Complementos: [["Alitas", "10 piezas, BBQ o búfalo", 149], ["Papas a la francesa", "Orden grande", 69], ["Pan de ajo", "Con queso", 59]], Bebidas: [["Refresco", "2 litros", 45]] },
    ...S(8, 5, "una pizza mediana gratis") },
  { id: "hamburguesas", nombre: "Hamburguesas", tipo: "menu", color: "#f08c00", que: "menú digital con pedidos y tarjeta de cliente frecuente",
    n: /burger|hamburgues|hot ?dogs?|dogos/, g: /pizzas, hamburguesas, hot dogs/, rubros: ["Hamburguesas"],
    cats: { Hamburguesas: [["Clásica", "Carne de res, queso y vegetales", 99], ["Doble con tocino", "Doble carne y queso cheddar", 149], ["BBQ", "Aros de cebolla y salsa BBQ", 139]], Papas: [["A la francesa", "Orden grande", 49], ["Gajo", "Con queso y tocino", 65]], Bebidas: [["Malteada", "Vainilla, fresa o chocolate", 69], ["Refresco", "600 ml", 30]] },
    ...S(10, 7, "una hamburguesa gratis") },
  { id: "mariscos", nombre: "Mariscos", tipo: "menu", color: "#0b7285", que: "menú digital con pedidos por WhatsApp",
    n: /marisc|pescad|ostion|cevich|aguachil|mar\b|sinaloa|nayarit|marinero|camaron/, g: /pescados y mariscos/, rubros: ["Mariscos"],
    cats: { Cócteles: [["Coctel de camarón", "Grande", 159], ["Campechana", "Camarón, pulpo y ostión", 189]], Platillos: [["Aguachile", "Verde o negro", 199], ["Filete empapelado", "Con verduras", 189], ["Camarones a la diabla", "Con arroz y ensalada", 219]], Bebidas: [["Michelada", "Litro", 75], ["Agua de coco", "Natural", 45]] } },
  { id: "sushi", nombre: "Sushi y comida oriental", tipo: "menu", color: "#e03131", que: "menú digital con pedidos y tarjeta de cliente frecuente",
    n: /sushi|japon|oriental|comida china|chinese|wok|ramen|teriyaki/,
    cats: { Rollos: [["California", "Surimi, pepino y aguacate", 119], ["Philadelphia", "Salmón y queso crema", 129], ["Empanizado especial", "Camarón y tampico", 145]], Calientes: [["Yakimeshi", "Arroz frito especial", 99], ["Pollo teriyaki", "Con arroz", 129]], Bebidas: [["Té verde", "Frío o caliente", 35]] },
    ...S(10, 6, "un rollo gratis") },
  { id: "pollo", nombre: "Pollos y alitas", tipo: "menu", color: "#f59f00", que: "menú digital con pedidos por WhatsApp",
    n: /pollo|rosticer|alitas|wings|polleria/, rubros: ["Pollerías"],
    cats: { Pollos: [["Pollo asado entero", "Con tortillas y salsa", 189], ["Medio pollo", "Con tortillas y salsa", 105]], Alitas: [["10 piezas", "BBQ, búfalo o mango habanero", 139], ["20 piezas", "Dos salsas", 259]], Extras: [["Arroz", "Orden", 35], ["Frijoles charros", "Orden", 35]] },
    ...S(10, 6, "un medio pollo gratis") },
  { id: "neveria", nombre: "Nevería y paletería", tipo: "cafe", color: "#f06595", que: "tarjeta de fidelidad digital y menú",
    n: /never|helad|paleter|michoacana|yogurt|frozen|raspado|nieve/, g: /paletas de hielo y helado|elaboracion de helados/, rubros: ["Neverías"],
    ...S(10, 6, "un helado gratis"),
    cats: { Helados: [["Sencillo", "Una bola, sabor a elegir", 45], ["Doble", "Dos bolas", 65], ["Banana split", "Tres sabores", 95]], Paletas: [["De agua", "Fruta natural", 25], ["De leche", "Cremosa", 30]] } },
  { id: "bar", nombre: "Bar", tipo: "menu", color: "#5f3dc4", que: "menú digital y reservaciones por WhatsApp",
    n: /\bbar\b|cantina|cerveceria|pub\b|antro|beer|mezcal|wings ?bar/, g: /bares, cantinas|centros nocturnos/,
    cats: { Cervezas: [["Nacional", "Media", 45], ["Cubeta", "6 cervezas", 199]], Cocteles: [["Margarita", "Limón o tamarindo", 89], ["Mojito", "Clásico", 89], ["Paloma", "Con tequila", 79]], Botanas: [["Alitas", "10 piezas", 149], ["Nachos", "Con queso y jalapeño", 109]] } },
  { id: "jugos", nombre: "Jugos y licuados", tipo: "cafe", color: "#2f9e44", que: "tarjeta de fidelidad digital y menú",
    n: /jugo|licuad|smoothie|frutas?\b|frutería|coctel de fruta/,
    ...S(10, 4, "un jugo gratis"),
    cats: { Jugos: [["Naranja", "Medio litro", 35], ["Verde", "Nopal, piña y apio", 45]], Licuados: [["Plátano", "Con avena", 40], ["Fresa", "Con leche", 45]], Fruta: [["Coctel de fruta", "Con yogurt y granola", 55]] } },
  { id: "cafeteria", nombre: "Cafetería", tipo: "cafe", color: "#8a5a3c", que: "tarjeta de fidelidad digital y menú digital",
    n: /cafe|coffee|cafeter|espresso|barista/, g: /cafeterias/, rubros: ["Cafeterías"],
    ...S(10, 7, "un café gratis"),
    cats: { Café: [["Americano", "12 oz", 40], ["Capuchino", "12 oz", 55], ["Latte", "Con leche de tu elección", 58], ["Frappé", "Moka, caramelo o vainilla", 69]], Pan: [["Pan de elote", "Rebanada", 45], ["Croissant", "Mantequilla", 38]] } },
  { id: "pasteleria", nombre: "Pastelería y panadería", tipo: "catalogo", color: "#c2255c", que: "catálogo de pasteles con pedidos por WhatsApp",
    n: /pastel|panad|reposter|cupcake|galleta|bakery|pan\b|postre|dulceria/, g: /panificacion|pasteles/, rubros: ["Pastelerías y panaderías"],
    items: [["Pastel de tres leches", "Para 15 personas", 380], ["Pastel de chocolate", "Relleno de ganache", 420], ["Cheesecake de frutos rojos", "Para 12 personas", 450], ["Cupcakes", "Caja de 6, decorados", 180], ["Galletas decoradas", "Docena, con tu diseño", 240], ["Pay de queso", "Tamaño familiar", 260]],
    ...S(8, 5, "una rebanada gratis") },
  { id: "taqueria", nombre: "Taquería", tipo: "menu", color: "#e8590c", que: "menú digital con pedidos y tarjeta de cliente frecuente",
    n: /taco|taquer|pastor|barbacoa|carnitas|birria|trompo/, g: /tacos y tortas/, rubros: ["Taquerías y comida"],
    cats: { Tacos: [["Pastor", "Orden de 5, con piña, cebolla y cilantro", 75], ["Asada", "Orden de 5", 85], ["Tripa", "Orden de 5, bien doradita", 90]], Especiales: [["Gringa", "Pastor con queso en tortilla de harina", 69], ["Quesadilla", "Con la carne que quieras", 45], ["Volcán", "Tostada con queso gratinado y carne", 35]], Bebidas: [["Refresco", "600 ml", 30], ["Agua de horchata", "Litro", 30]] },
    ...S(10, 6, "una orden gratis") },
  { id: "loncheria", nombre: "Lonchería y antojitos", tipo: "menu", color: "#e67700", que: "menú digital con pedidos por WhatsApp",
    n: /lonch|torta|gordit|antoj|tamal|burrit|menudo|fonda|cocina economica|comida corrida|asadero|enchilad|flautas|pozole/, g: /antojitos/, rubros: ["Gorditas y antojitos"],
    cats: { Antojitos: [["Gorditas", "Chicharrón, deshebrada o rajas", 25], ["Burritos", "De harina, varios guisos", 40], ["Tortas", "Asada, milanesa o jamón", 65]], "Comida del día": [["Menú del día", "Sopa, guisado, arroz y agua", 95], ["Caldo de res", "Con verduras", 85]], Bebidas: [["Agua fresca", "Medio litro", 25], ["Café de olla", "Taza", 20]] },
    ...S(10, 6, "una orden gratis") },
  { id: "restaurante", nombre: "Restaurante", tipo: "menu", color: "#d9480f", que: "menú digital con pedidos y asistente de IA", ia: true,
    n: /restaur|cocina|comida|asador|carnes|grill|buffet|steak|parrilla|bistro|cenaduria/, g: /restaurantes|comida corrida|a la carta/, rubros: ["Restaurantes"],
    cats: { Entradas: [["Guacamole con totopos", "Aguacate, jitomate, cebolla y chile serrano", 89], ["Queso fundido", "Con chorizo y tortillas de harina", 99]], "Platos fuertes": [["Arrachera con guarnición", "300 g, frijoles charros y ensalada", 219], ["Enchiladas suizas", "Pollo, salsa verde cremosa y gratinadas", 149], ["Pechuga a la plancha", "Con arroz y verduras salteadas", 159]], Bebidas: [["Agua fresca del día", "Litro", 35], ["Limonada mineral", "Natural", 45], ["Café de olla", "Con canela y piloncillo", 35]] } },
];

const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const bonito = (giro) => {
  const g = String(giro || "")
    .replace(/^(comercio al por (menor|mayor) (de|en) |servicios de |otros servicios de |reparaci[oó]n y mantenimiento de )/i, "")
    .replace(/ del sector privado| del sector p[uú]blico/gi, "")
    .trim();
  return g ? g.charAt(0).toUpperCase() + g.slice(1) : "Nuestros servicios";
};

/** Perfil para cualquier giro que no esté en la lista: una página de servicios armada con su giro real. */
function generico(p) {
  return {
    id: "servicios", nombre: "Cualquier negocio", tipo: "servicios", color: "#343a40", que: "página web con cotizaciones por WhatsApp", ia: true,
    items: [[bonito(p.giro), "Atención personalizada y precios claros"], ["Cotización sin compromiso", "Te respondemos por WhatsApp el mismo día"], ["Servicio a domicilio", "Pregunta por tu zona"], ["Facturación", "Para personas y empresas"]],
  };
}

/**
 * Elige el perfil de un negocio: 1) giro "fuerte" (salud, autos, profesiones, comercio),
 * 2) nombre, 3) giro de cualquier perfil, 4) rubro con que se buscó, 5) genérico con su giro.
 */
export function perfilDe(p) {
  const n = norm(p.nombre);
  const g = norm(p.giro);
  return (
    PERFILES.find((x) => x.fuerte && x.g && g && x.g.test(g)) ||
    PERFILES.find((x) => x.n && x.n.test(n)) ||
    PERFILES.find((x) => x.g && g && x.g.test(g)) ||
    PERFILES.find((x) => x.rubros?.includes(p.rubro)) ||
    generico(p)
  );
}

/** Perfiles para la galería (más el genérico). */
export const perfilesGaleria = () => [...PERFILES, generico({ giro: "Servicios profesionales" })];
