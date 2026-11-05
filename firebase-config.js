/* Configuración pública de Firebase para Áurea.
   Mientras sea null, la app funciona como prototipo local (cada navegador guarda sus datos).
   Para activar cuentas y datos compartidos, reemplaza null por el bloque firebaseConfig del proyecto
   y agrega la lista de correos administradores, por ejemplo:

   window.AUREA_FIREBASE = {
     apiKey: "…", authDomain: "aurea-app.firebaseapp.com", projectId: "aurea-app",
     storageBucket: "aurea-app.appspot.com", messagingSenderId: "…", appId: "…",
     admins: ["racinesdaniel@gmail.com"]
   };
   Estos valores no son secretos: identifican el proyecto. La seguridad la dan las reglas de firestore.rules. */
window.AUREA_FIREBASE = {
  apiKey: "AIzaSyArM6yo05Sn-EqPIsH4ddtiN39OxhqvkpE",
  authDomain: "aurea-app-dr.firebaseapp.com",
  projectId: "aurea-app-dr",
  storageBucket: "aurea-app-dr.firebasestorage.app",
  messagingSenderId: "428142295332",
  appId: "1:428142295332:web:cf470521e4a0e27b601bb1",
  admins: ["racinesdaniel@gmail.com"]
};
