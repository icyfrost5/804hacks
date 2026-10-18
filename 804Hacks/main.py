import csv
import io
import logging
import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from statistics import fmean

from fastapi import FastAPI, HTTPException, Request
from starlette.responses import FileResponse
import openmeteo_requests
import requests
import requests_cache
from retry_requests import retry

AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
AIR_QUALITY_VARIABLES = [
    ("PM10", "pm10", "µg/m³"),
    ("PM2.5", "pm2_5", "µg/m³"),
    ("Carbon monoxide", "carbon_monoxide", "µg/m³"),
    ("Nitrogen dioxide", "nitrogen_dioxide", "µg/m³"),
    ("Sulphur dioxide", "sulphur_dioxide", "µg/m³"),
    ("Ozone", "ozone", "µg/m³"),
    ("US AQI", "us_aqi", "AQI"),
]
LOCATIONS = [
    ("Alexandria", 38.820450, -77.050552),
    ("Fairfax", 38.798631, -77.328126),
    ("Arlington", 38.8810, -77.1043),
    ("Manassas", 38.7509, -77.4753),
    ("Leesburg", 39.1157, -77.5636),
    ("Purcellville", 39.1368, -77.7147),
    ("Winchester", 39.18566, -78.16333),
    ("Front Royal", 38.9182, -78.1944),
    ("Culpeper", 38.4732, -78.0042),
    ("Charlottesville", 38.0293, -78.4767),
    ("Waynesboro", 38.0685, -78.8895),
    ("Harrisonburg", 38.44957, -78.86892),
    ("Staunton", 38.149574, -79.071693),
    ("Lexington", 37.7840, -79.4428),
    ("Roanoke", 37.270969, -79.941429),
    ("Blacksburg", 37.2296, -80.4139),
    ("Christiansburg", 37.1299, -80.4089),
    ("Lynchburg", 37.413753, -79.142246),
    ("Danville", 36.58597, -79.3950),
    ("Martinsville", 36.6915, -79.8725),
    ("Petersburg", 37.2279, -77.4019),
    ("Richmond", 37.5407, -77.4360),
    ("Farmville", 37.3021, -78.3919),
    ("Emporia", 36.6860, -77.5425),
    ("Williamsburg", 37.2707, -76.7075),
    ("Yorktown", 37.2388, -76.5097),
    ("Newport News", 37.0871, -76.4730),
    ("Hampton", 37.0299, -76.3452),
    ("Poquoson", 37.1224, -76.3458),
    ("Norfolk", 36.8508, -76.2859),
    ("Chesapeake", 36.7682, -76.2875),
    ("Suffolk", 36.7282, -76.5836),
    ("Smithfield", 36.9824, -76.6315),
    ("Virginia Beach", 36.8529, -75.9780),
    ("Onancock", 37.7104, -75.7494),
    ("Chincoteague", 37.9332, -75.3788),
    ("Fredericksburg", 38.3032, -77.4605),
    ("Abingdon", 36.7098, -81.9773),
    ("Bristol", 36.5951, -82.1887),
    ("Big Stone Gap", 36.8640, -82.7790),
    ("Wise", 36.9754, -82.5757),
]
WQP_RESULT_URL = "https://www.waterqualitydata.us/data/Result/search"
WQP_STATION_URL = "https://www.waterqualitydata.us/data/Station/search"
GBIF_OCCURRENCE_URL = "https://api.gbif.org/v1/occurrence/search"
WQP_CATEGORIES = {
    "Water": {
        "Dissolved oxygen",
        "Nitrate",
        "pH",
        "Turbidity",
    },
    "Waste": {
        "Total suspended solids",
        "Escherichia coli",
        "Oil and grease",
    },
}
WQP_CHARACTERISTICS = sorted(set().union(*WQP_CATEGORIES.values()))
logger = logging.getLogger(__name__)

cache_session = requests_cache.CachedSession(
    ".cache", backend="memory", expire_after=3600
)
source_session = requests_cache.CachedSession(
    ".cache", backend="memory", expire_after=3600
)
openmeteo = openmeteo_requests.Client(
    session=retry(cache_session, retries=3, backoff_factor=0.5)
)


def nearest_city(latitude, longitude):
    return min(
        LOCATIONS,
        key=lambda location: math.hypot(
            (location[1] - latitude) * 111,
            (location[2] - longitude) * 111 * math.cos(math.radians(latitude)),
        ),
    )[0]


def get_air_quality_data():
    parameters = {
        "latitude": [latitude for _, latitude, _ in LOCATIONS],
        "longitude": [longitude for _, _, longitude in LOCATIONS],
        "hourly": ",".join(variable for _, variable, _ in AIR_QUALITY_VARIABLES),
        "past_days": 1,
        "forecast_days": 1,
        "timezone": "UTC",
    }
    responses = openmeteo.weather_api(AIR_QUALITY_URL, params=parameters)
    now = datetime.now(timezone.utc).timestamp()
    sites = []

    for site_id, (response, (city, latitude, longitude)) in enumerate(
        zip(responses, LOCATIONS, strict=True), start=1
    ):
        hourly = response.Hourly()
        timestamps = [
            hourly.Time() + index * hourly.Interval()
            for index in range(hourly.Variables(0).ValuesAsNumpy().size)
        ]
        current_index = max(
            (index for index, timestamp in enumerate(timestamps) if timestamp <= now),
            default=0,
        )
        readings = []

        for variable_index, (label, _, unit) in enumerate(AIR_QUALITY_VARIABLES):
            values = hourly.Variables(variable_index).ValuesAsNumpy()
            value = values[current_index]
            if value == value:
                historical_values = values[max(0, current_index - 24):current_index]
                valid_values = [
                    float(sample) for sample in historical_values
                    if math.isfinite(float(sample))
                ]
                readings.append({
                    "metric": label,
                    "value": round(float(value), 2),
                    "unit": unit,
                    "baseline": round(fmean(valid_values), 2) if valid_values else round(float(value), 2),
                    "baseline_label": "Previous 24 hourly readings",
                })

        aqi = next(
            (reading["value"] for reading in readings if reading["metric"] == "US AQI"),
            None,
        )
        if aqi is None:
            status = "Watch"
            baseline = None
            issue = "US AQI is unavailable for this location."
            recommendation = "Check the latest local air-quality guidance."
        else:
            status = "Normal" if aqi <= 50 else "Watch" if aqi <= 100 else "Anomaly"
            aqi_reading = next(reading for reading in readings if reading["metric"] == "US AQI")
            baseline = aqi_reading["baseline"]
            issue = f"Current US AQI is {aqi:.0f}."
            recommendation = (
                "Air quality is generally good; continue routine monitoring."
                if status == "Normal"
                else "Review current air-quality guidance, especially for sensitive groups."
                if status == "Watch"
                else "Review official air-quality guidance and limit exposure as appropriate."
            )

        sites.append({
            "id": site_id,
            "name": f"{city} Air Quality",
            "city": city,
            "lat": latitude,
            "lng": longitude,
            "category": "Air",
            "metric": "US AQI",
            "value": aqi if aqi is not None else "Unavailable",
            "unit": "AQI",
            "baseline": baseline if baseline is not None else "Unavailable",
            "baseline_label": "Previous 24 hourly readings",
            "status": status,
            "issue": issue,
            "recommendation": recommendation,
            "readings": readings,
            "observed_at": datetime.fromtimestamp(
                timestamps[current_index], timezone.utc
            ).isoformat(),
            "source": "Open-Meteo",
            "source_url": "https://open-meteo.com/",
        })

    return sites


def get_water_quality_data():
    start_date = datetime.now(timezone.utc).date() - timedelta(days=365)
    parameters = [
        ("statecode", "US:51"),
        ("siteType", "Stream"),
        *(("characteristicName", name) for name in WQP_CHARACTERISTICS),
        ("startDateLo", start_date.strftime("%m-%d-%Y")),
        ("mimeType", "csv"),
        ("zip", "no"),
    ]
    response = source_session.get(
        WQP_RESULT_URL,
        params=parameters,
        headers={"User-Agent": "EcoSentinel/1.0 (Virginia environmental dashboard)"},
        timeout=45,
    )
    response.raise_for_status()

    grouped = {category: {} for category in WQP_CATEGORIES}
    reference_values = {category: {} for category in WQP_CATEGORIES}
    for row in csv.DictReader(io.StringIO(response.text)):
        station_id = row.get("MonitoringLocationIdentifier")
        characteristic = row.get("CharacteristicName")
        sample_date = row.get("ActivityStartDate")
        if not station_id or not sample_date:
            continue

        category = next(
            (name for name, characteristics in WQP_CATEGORIES.items()
             if characteristic in characteristics),
            None,
        )
        if category is None:
            continue

        try:
            value = float(row.get("ResultMeasureValue", ""))
        except (TypeError, ValueError):
            continue

        unit = row.get("ResultMeasure/MeasureUnitCode") or ""
        unit = "" if unit == "None" else unit
        metric_key = (characteristic, unit)
        station = grouped[category].setdefault(station_id, {
            "date": sample_date,
            "name": row.get("MonitoringLocationName"),
            "readings": {},
            "history": {},
        })
        station["history"].setdefault(metric_key, []).append((sample_date, value))
        reference_values[category].setdefault(metric_key, []).append(value)
        if sample_date > station["date"]:
            station["date"] = sample_date
            station["readings"] = {}
        if sample_date == station["date"]:
            station["readings"][characteristic] = {
                "metric": characteristic,
                "value": round(value, 3),
                "unit": unit,
            }

    station_ids = sorted(set().union(*(records.keys() for records in grouped.values())))
    if not station_ids:
        return []

    station_response = source_session.post(
        WQP_STATION_URL,
        params={"mimeType": "csv", "zip": "no"},
        json={"siteid": station_ids},
        headers={"User-Agent": "EcoSentinel/1.0 (Virginia environmental dashboard)"},
        timeout=45,
    )
    station_response.raise_for_status()
    station_locations = {}
    for row in csv.DictReader(io.StringIO(station_response.text)):
        try:
            latitude = float(row.get("LatitudeMeasure", ""))
            longitude = float(row.get("LongitudeMeasure", ""))
        except (TypeError, ValueError):
            continue
        station_locations[row["MonitoringLocationIdentifier"]] = {
            "lat": latitude,
            "lng": longitude,
            "name": row.get("MonitoringLocationName"),
        }

    sites = []
    for category, records in grouped.items():
        candidates = [
            (station_id, record, station_locations[station_id])
            for station_id, record in records.items()
            if station_id in station_locations and record["readings"]
        ]
        used_stations = set()

        for city, latitude, longitude in LOCATIONS:
            closest = min(
                (
                    (
                        math.hypot(
                            (location["lat"] - latitude) * 111,
                            (location["lng"] - longitude)
                            * 111 * math.cos(math.radians(latitude)),
                        ),
                        station_id,
                        record,
                        location,
                    )
                    for station_id, record, location in candidates
                    if station_id not in used_stations
                ),
                default=None,
                key=lambda candidate: candidate[0],
            )
            if closest is None or closest[0] > 100:
                continue

            _, station_id, record, location = closest
            used_stations.add(station_id)
            readings = sorted(
                record["readings"].values(), key=lambda reading: reading["metric"]
            )
            for reading in readings:
                metric_key = (reading["metric"], reading["unit"])
                prior_values = [
                    value
                    for sample_date, value in record["history"].get(metric_key, [])
                    if sample_date < record["date"]
                ]
                baseline_values = prior_values or reference_values[category].get(metric_key, [])
                reading["baseline"] = round(fmean(baseline_values), 3) if baseline_values else reading["value"]
                reading["baseline_label"] = (
                    "Previous station samples (12 months)"
                    if prior_values
                    else "Virginia 12-month mean"
                )
            first_reading = readings[0]
            sites.append({
                "name": location["name"] or record["name"] or f"{city} {category} Sample",
                "city": city,
                "lat": location["lat"],
                "lng": location["lng"],
                "category": category,
                "metric": first_reading["metric"],
                "value": first_reading["value"],
                "unit": first_reading["unit"],
                "baseline": first_reading["baseline"],
                "baseline_label": first_reading["baseline_label"],
                "status": "Watch",
                "issue": (
                    f"Reported {category.lower()} sample collected {record['date']}. "
                    "This historical sample has not been screened against a water-quality standard."
                ),
                "recommendation": (
                    "Interpret the result using its sampling context and applicable "
                    "water-quality criteria."
                ),
                "readings": readings,
                "observed_at": record["date"],
                "source": "Water Quality Portal",
                "source_url": "https://www.waterqualitydata.us/",
            })

    return sites


def get_biodiversity_data():
    end_date = datetime.now(timezone.utc).date()
    current_start = end_date.replace(day=1)
    previous_end = current_start - timedelta(days=1)
    previous_start = previous_end.replace(day=1)

    def fetch_occurrences(start_date, stop_date):
        response = requests.get(
            GBIF_OCCURRENCE_URL,
            params={
                "country": "US",
                "stateProvince": "Virginia",
                "hasCoordinate": "true",
                "basisOfRecord": "HUMAN_OBSERVATION",
                "eventDate": f"{start_date},{stop_date}",
                "limit": 300,
            },
            headers={"User-Agent": "EcoSentinel/1.0 (Virginia environmental dashboard)"},
            timeout=30,
        )
        response.raise_for_status()
        return response.json().get("results", [])

    with ThreadPoolExecutor(max_workers=2) as executor:
        current_future = executor.submit(fetch_occurrences, current_start, end_date)
        previous_future = executor.submit(fetch_occurrences, previous_start, previous_end)
        current_occurrences = current_future.result()
        previous_occurrences = previous_future.result()

    def in_virginia(occurrence):
        latitude = occurrence.get("decimalLatitude")
        longitude = occurrence.get("decimalLongitude")
        return (
            latitude is not None
            and longitude is not None
            and 36.5 <= latitude <= 39.5
            and -83.7 <= longitude <= -75.2
        )

    def species_name(occurrence):
        return occurrence.get("acceptedScientificName") or occurrence.get(
            "scientificName", "Unidentified species"
        )

    prior_counts = Counter(
        (nearest_city(occurrence["decimalLatitude"], occurrence["decimalLongitude"]), species_name(occurrence))
        for occurrence in previous_occurrences
        if in_virginia(occurrence)
    )

    sites = []
    for occurrence in current_occurrences:
        latitude = occurrence.get("decimalLatitude")
        longitude = occurrence.get("decimalLongitude")
        if not in_virginia(occurrence):
            continue

        city = nearest_city(latitude, longitude)
        scientific_name = species_name(occurrence)
        observed_at = occurrence.get("eventDate", "Date not supplied")
        occurrence_id = occurrence.get("key")
        baseline = prior_counts[(city, scientific_name)]
        sites.append({
            "name": scientific_name,
            "city": city,
            "lat": latitude,
            "lng": longitude,
            "category": "Biodiversity",
            "metric": "Species observation",
            "value": 1,
            "unit": "record",
            "baseline": baseline,
            "baseline_label": "Previous-month GBIF records for this species and location",
            "status": "Normal",
            "issue": (
                f"Species occurrence recorded {observed_at}. Presence records do not "
                "estimate population size or trend."
            ),
            "recommendation": (
                "Review the observation and identification in its original dataset."
            ),
            "readings": [{
                "metric": "Species observation",
                "value": 1,
                "unit": "record",
                "baseline": baseline,
                "baseline_label": "Previous-month GBIF records for this species and location",
            }],
            "observed_at": observed_at,
            "source": "GBIF",
            "source_url": f"https://www.gbif.org/occurrence/{occurrence_id}",
            "license": occurrence.get("license", "Not supplied"),
        })

    return sites


def get_connected_sites():
    sites = []
    for data_provider in (
        get_air_quality_data,
        get_water_quality_data,
        get_biodiversity_data,
    ):
        try:
            sites.extend(data_provider())
        except Exception:
            logger.exception("Monitoring data provider failed: %s", data_provider.__name__)

    for site_id, site in enumerate(sites, start=1):
        site["id"] = site_id
    return sites


app = FastAPI()

@app.exception_handler(404)
def handler_404 (request: Request, exception: HTTPException):
    return FileResponse("./frontend/404.html")

@app.get('/')
def read_root():
    return FileResponse("./frontend/index.html")


@app.get('/api/sites')
def read_sites():
    try:
        sites = get_connected_sites()
        if not sites:
            raise HTTPException(status_code=502, detail="Monitoring data is unavailable.")
        return sites
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail="Monitoring data is temporarily unavailable.",
        ) from error


@app.get('/script.js')
def read_script():
    return FileResponse("./frontend/script.js")


    

