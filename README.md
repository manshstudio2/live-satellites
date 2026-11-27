# Live Satellites

An Android-first web prototype with two views. **AR View** compares a bright camera target near the reticle with predicted satellite tracks. **3D Earth** shows the observer and satellites above the local horizon on a rotatable globe. In AR View, active satellites are overlaid automatically without a default target. Search by name in 3D Earth. The ISS is excluded from both views.

## Local build and deployment

Run `npm ci` and `npm run dev` locally. Run `npm run build` for production. AWS Amplify can publish the static `dist` output from Git or from a ZIP containing the contents of `dist`. Phone camera, orientation and location APIs need a trusted HTTPS URL.

## Data and field testing

The prototype uses the CelesTrak active GP CSV catalog, and reports when the active catalog is unavailable. It caches successful responses in browser Cache Storage, attempts each feed at most once per two hours per browser, and pauses requests after an HTTP error. Investigate the upstream error before clearing site storage to resume. For wider rollout, review the [CelesTrak usage policy](https://celestrak.org/usage-policy.php) and use an approved shared cache to reduce upstream requests. The globe uses NASA Blue Marble Next Generation (July 2004) and VIIRS Black Marble (2016) imagery with a current Sun position.

In Android Chrome or iPhone Safari, grant camera and location access. Hold a light near the center of the camera for a few seconds. Results are candidate matches and use an estimated camera field of view. Check tracking outdoors against a known pass before relying on it. Pass times are geometric 10-degree crossings. Optical visibility depends on illumination, weather, haze and brightness.
