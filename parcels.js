// Land parcels and owners from states that publish them free (public property records).
// Nationwide coverage needs a paid provider (e.g. Regrid); this covers the states with open
// statewide layers that browsers can read. Owner names only appear when someone taps for them.

// State → public parcel layer (ArcGIS FeatureServer layer URL).
export const PARCEL_LAYERS = {
  WI: 'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0',
  NC: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1',
  AR: 'https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6',
  FL: 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0',
  CO: 'https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0',
  VT: 'https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0',
  CT: 'https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0',
  OH: 'https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0',
  IN: 'https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0',
  ND: 'https://services1.arcgis.com/GOcSXpzwBHyk2nog/arcgis/rest/services/NDGISHUB_Parcels/FeatureServer/0',
  CA: 'https://bz1uwWPKUInZBK94.svcs5.arcgis.com/bz1uwWPKUInZBK94/arcgis/rest/services/CA_Statewide_Parcels_Public_view/FeatureServer/0',
  UT: 'https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer/0',
  NJ: 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0',
};

const first = (attrs, re, ok = (v) => v != null && String(v).trim() !== '') => {
  for (const [k, v] of Object.entries(attrs)) if (re.test(k) && ok(v)) return v;
  return null;
};

// Pull the useful bits out of whatever field names a state uses.
function normalize(a) {
  const owner = [
    first(a, /^(own(er)?(nme1|name|_name|1)?|ownname|ownername|owner_name)$/i),
    first(a, /^(own(er)?(nme2|2)|co_owner)$/i),
  ].filter(Boolean).map((s) => String(s).trim()).join(' & ') || null;
  const acres = first(a, /acre/i, (v) => Number(v) > 0.01);
  const id = first(a, /^(parcel_?id|parcelid|parno|state_parcel_id|stateparcelid|parcel_apn|pams_pin|span|pin)$/i);
  const county = first(a, /^(cntyname|county(_?name)?|conamelong)$/i);
  // Land-use descriptions only; numeric class codes mean nothing to people.
  const use = first(a, /^(propclass|prop_class|parusedesc|landuse|land_use|own_type)$/i, (v) => v != null && /[a-z]{3}/i.test(String(v)));
  return { owner, acres: acres != null ? Math.round(Number(acres) * 10) / 10 : null, id, county, use };
}

/** Parcel at a point: { info, geojson } or { unsupported: true } when the state has no open layer. */
export async function parcelAt(lat, lon, st) {
  const url = PARCEL_LAYERS[st];
  if (!url) return { unsupported: true };
  const q = new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'geojson',
  });
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`${url}/query?${q}`, { signal: ctl.signal });
    const j = await res.json();
    const f = j.features?.[0];
    if (!f) return { none: true };
    return { info: normalize(f.properties || {}), geojson: f };
  } finally { clearTimeout(t); }
}
