# StormTrack API — NHC Advisory Proxy

Endpoint serverless para StormTrack. Descarga y procesa shapefiles oficiales del NHC en tiempo real.

## Deploy en Vercel

```bash
npm install -g vercel
cd stormtrack-api
vercel deploy --prod
```

## Endpoints

### GET /api/nhc-latest
Devuelve el advisory más reciente del Atlántico.

**Query params:**
- `basin=at` (Atlántico, default)
- `basin=ep` (Pacífico Este)

**Response:**
```json
{
  "active": true,
  "stormId": "al152023",
  "advisoryNum": "015",
  "title": "Hurricane LEE Advisory 15...",
  "fetchedAt": "2023-09-14T21:00:00Z",
  "coneCoords": [[lon,lat], ...],
  "trackCoords": [[lon,lat], ...],
  "forecastPts": [{"tau":0, "wind":145, ...}]
}
```

### Cache
Vercel cachea 5 minutos (300s) automáticamente.

## Costo
Gratis en plan Hobby de Vercel (100GB bandwidth/mes, más que suficiente).
