# Midl

Enter two locations and a max travel time. The map shows where both are within reach.

## Run it locally
1. Get a free key at https://www.geoapify.com (sign up, create a project, copy its API key).
2. `cp .env.example .env` and paste the key after `VITE_GEOAPIFY_KEY=`.
3. `npm install`
4. `npm run dev` and open the URL it prints.

## Deploy on Vercel
1. Push to GitHub and import the repo in Vercel (framework: Vite).
2. In Project Settings > Environment Variables, add `VITE_GEOAPIFY_KEY`.
3. Deploy.

Note: a `VITE_` key ships inside the site's JavaScript, so anyone can see it. Fine for a personal tool; for a public launch, move the calls into a small serverless function.
