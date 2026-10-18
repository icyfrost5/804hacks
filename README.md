## Inspiration

Environmental data can be scattered across different sources, making it difficult to see where attention may be needed. We wanted to create a clear, approachable way to bring key environmental indicators together and help people explore them.

## What it does

EcoSentinel provides a dashboard for air, water, waste, and biodiversity monitoring. Users can explore monitoring sites on a map, review site information and anomaly alerts, and use a scenario tool to explore hypothetical environmental impacts. Live monitoring records require a connected data provider; scenario results are illustrative, not forecasts.

## How we built it

We built EcoSentinel as a browser-based application using HTML, CSS, and JavaScript, with Leaflet for the interactive map. The dashboard is structured to load monitoring records from a backend data provider, while the scenario tool groups available readings and calculates conceptual projections.

## Challenges we ran into

A key challenge was presenting different types of environmental measurements in one consistent interface. We also needed to make it clear when live data is unavailable and distinguish hypothetical scenario results from actual monitoring data.

## Accomplishments that we're proud of

We’re proud to have brought four environmental categories into one dashboard, with a map, site browsing, alert views, and a scenario tool. We also designed the experience to communicate its data limitations rather than imply that disconnected or hypothetical data is live monitoring.

## What we learned

We learned that environmental data is most useful when it comes with context: where it came from, what it measures, and what assumptions shape any projections. Clear communication is just as important as visualization.

## What's next for EcoSentinel

Next, we’d connect a reliable monitoring data provider, validate the dashboard with environmental professionals and community stakeholders, and improve the context and guidance provided alongside alerts and scenario results.
