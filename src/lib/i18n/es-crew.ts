/**
 * The crew's screens: write-ups, room sketches, the equipment scanner, the
 * sign-in and install screens, and the offline messages a phone in a basement
 * shows. Most field-form labels already carry their own Spanish through
 * `bi()`; this is the rest. Labels only — see `./index.ts`.
 */
export const CREW_ES: Record<string, string> = {
  // Write-ups
  "Write-ups": "Reportes de trabajo",
  "Visit date": "Fecha de visita",
  Room: "Habitación",
  "General (no room)": "General (sin habitación)",
  "Work done": "Trabajo realizado",
  "Removed drywall 2 ft flood cut": "Se retiró tablaroca, corte de inundación de 2 pies",
  "Nothing written up for this visit yet.": "Todavía no hay nada registrado para esta visita.",
  "Other visits:": "Otras visitas:",
  "Add to write-up": "Agregar al reporte",
  "The work done on a visit, room by room. It shows on the Scope of work.":
    "El trabajo realizado en una visita, habitación por habitación. Aparece en el Alcance del trabajo.",

  // Room sketches
  "Room sketches": "Croquis de habitaciones",
  "Room for the sketch": "Habitación del croquis",
  "Whole floor (no room)": "Todo el piso (sin habitación)",
  Floor: "Piso",
  "1st floor": "Primer piso",
  "No sketches on this job yet.": "Todavía no hay croquis en este trabajo.",
  "New sketch": "Nuevo croquis",
  "Sketch saved": "Croquis guardado",
  "The plan could not be made": "No se pudo crear el plano",
  "Markup tools": "Herramientas de marcado",

  // Equipment
  Dehumidifier: "Deshumidificador",
  Dehumidifiers: "Deshumidificadores",
  "Air mover": "Ventilador de aire",
  "Air movers": "Ventiladores de aire",
  "Air scrubber": "Purificador de aire",
  "Scan a tag": "Escanear etiqueta",
  "Asset tag": "Etiqueta de activo",
  Install: "Instalar",
  Pick: "Retirar",

  // Install / PWA
  "Install on iPhone": "Instalar en iPhone",
  "Install Recovery Hub": "Instalar Recovery Hub",
  "Add Recovery Hub to your home screen": "Agregue Recovery Hub a su pantalla de inicio",
  "Install Recovery Hub on this phone": "Instalar Recovery Hub en este teléfono",
  "Show me": "Muéstreme",
  "Not now": "Ahora no",
  "Put Recovery Hub on your home screen so it opens full-screen like an app, without the Safari bars.":
    "Ponga Recovery Hub en su pantalla de inicio para que se abra a pantalla completa como una app, sin las barras de Safari.",
  "Put Recovery Hub on your home screen so it opens full-screen like an app, without the browser bars.":
    "Ponga Recovery Hub en su pantalla de inicio para que se abra a pantalla completa como una app, sin las barras del navegador.",

  // Offline and sync
  Discard: "Descartar",
  "Photo (full resolution)": "Foto (resolución completa)",
  "Waiting to sync": "Esperando sincronización",
  Syncing: "Sincronizando",
  "All changes synced": "Todos los cambios sincronizados",

  // Mitigation words used across the drying screens
  Mitigation: "Mitigación",
  Drying: "Secado",
  Moisture: "Humedad",
  Reading: "Lectura",
  Readings: "Lecturas",
  "Sign-in sheet": "Hoja de registro",
  "Daily sign-in sheet": "Hoja de registro diaria",
};
