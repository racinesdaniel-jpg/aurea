# Áurea

Landing y aplicación de mentoría «La Espiral de la Plenitud».

- `index.html`: landing
- `app.html`: aplicación
- `firebase-config.js`: configuración pública de Firebase (si es `null`, la app funciona en modo local)
- `firestore.rules`: reglas de acceso a la base de datos
- `firebase.json` y `.firebaserc`: publicación en Firebase Hosting (proyecto `aurea-app`)

## Datos en Firestore

- `users/{uid}`: correo, nombre, fecha de registro y el estado completo de la persona (registro, rueda de la vida, ruta, progreso y suscripción) en el campo `state`.
- `settings/app`: días de prueba (`trialDays`) y precios (`priceM`, `priceA`).

## Publicar

```
firebase deploy --only hosting,firestore:rules
```

El sitio también se publica en GitHub Pages desde la rama `main`.
