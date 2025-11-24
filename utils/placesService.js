const axios = require('axios');

function normalizePlace(result) {
  if (!result) return null;
  return {
    place_id: result.place_id,
    name: result.name,
    rating: result.rating,
    geometry: {
      location: {
        lat: result.geometry?.location?.lat,
        lng: result.geometry?.location?.lng,
      },
    },
  };
}

// Returns the closest place for the given keyword using rank-by-distance, with a fallback to radius search; or null
async function nearbyBestPlaceByKeyword({ lat, lng, radius = 500, keyword }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY not configured');
  const kw = String(keyword || '').slice(0, 64);
  // First try rankby=distance (must not include radius)
  const paramsDist = new URLSearchParams({
    key,
    location: `${lat},${lng}`,
    rankby: 'distance',
    keyword: kw,
  });
  const urlDist = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${paramsDist.toString()}`;
  console.log('[places] request rankby=distance', { lat, lng, keyword: kw });
  let resp;
  try {
    resp = await axios.get(urlDist, { timeout: 10000 });
  } catch (e) {
    console.warn('[places] distance request failed, falling back to radius', e?.message);
  }
  let results = Array.isArray(resp?.data?.results) ? resp.data.results : [];
  if (!results.length) {
    // Fallback: traditional radius search
    const paramsRad = new URLSearchParams({
      key,
      location: `${lat},${lng}`,
      radius: String(radius || 500),
      keyword: kw,
    });
    const urlRad = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${paramsRad.toString()}`;
    console.log('[places] request radius fallback', { radius, keyword: kw });
    const resp2 = await axios.get(urlRad, { timeout: 10000 });
    if (resp2.status !== 200) throw new Error(`Places error ${resp2.status}`);
    results = Array.isArray(resp2.data?.results) ? resp2.data.results : [];
  }
  console.log('[places] results count', results.length);
  if (!results.length) return null;
  // For distance ranked, first element is best; otherwise pick by rating
  const normalized = results.map(normalizePlace).filter(Boolean);
  if (!normalized.length) return null;
  if (paramsDist) {
    return normalized[0];
  }
  // rating sort fallback
  return normalized.sort((a, b) => (b.rating || 0) - (a.rating || 0))[0] || null;
}

module.exports = { nearbyBestPlaceByKeyword };
