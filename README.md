# LIve Satellites

An Android-first web prototype with two views. **AR View** compares a bright camera target near the reticle with predicted satellite tracks. **2D View** shows the selected satellite's current position, ground track, altitude and local pass information. Search by name or NORAD catalog ID.

## Local build and deployment

Run `npm ci` and `npm run dev` locally. Run `npm run build` for production. AWS Amplify can publish the static `dist` output from Git or from a ZIP containing the contents of `dist`. Phone camera, orientation and location APIs need a trusted HTTPS URL.

## Data and field testing

The prototype uses the CelesTrak active GP CSV catalog, with an ISS fallback when the active feed is unavailable. It caches successful responses in browser Cache Storage, attempts each feed at most once per two hours per browser, and pauses requests after an HTTP error. Investigate the upstream error before clearing site storage to resume. For wider rollout, review the [CelesTrak usage policy](https://celestrak.org/usage-policy.php) and use an approved shared cache to reduce upstream requests. The map uses the public-domain Natural Earth 1:110m land layer.

On a supported Android phone, grant camera and location access. Hold a light near the center of the camera for a few seconds. Results are candidate matches and use an estimated camera field of view. Check tracking outdoors against a known pass before relying on it. Pass times are geometric 10-degree crossings. Optical visibility depends on illumination, weather, haze and brightness.

