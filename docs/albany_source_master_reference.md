# Albany Crime Tracker — Master Source Reference

_Compiled April 14, 2026 · Source for `app.albany.watch`_

This document is the prose half of the original combined master file.
The two JSON Schemas that previously lived in the same document have been
moved to:

- [`schemas/incident.schema.json`](../schemas/incident.schema.json) — ACT incident contract
- [`schemas/source.schema.json`](../schemas/source.schema.json) — ACT source contract

---

## SECTION 1 — OFFICIAL PRIMARY DATA SOURCES
(Structured, machine-readable, or regularly published blotters — highest quality)

### 1.1 APD OPEN DATA PORTAL — Albany City Police Department
Domain: https://apd-data.albanyny.gov
Platform: Socrata / Tyler Technologies
Auth required: None (public read)
Format: JSON via SODA API; also CSV / Excel export
Update frequency: Near-daily for arrests; monthly refresh for crime reports
Also accessible at: https://data.albanyny.gov

Datasets:
  - Arrests by Neighborhood       (current YTD, geocoded to neighborhood)
  - Arrests by Patrol Zone        (same data, zone geocoding)
  - Arrests by Beat               (same data, beat-level geocoding)
  - Crimes Reported by Neighborhood
  - Crimes Reported by Patrol Zone
  - Crimes Reported by Beat
  - Calls for Service by Patrol Zone
  - Auto Accidents Map

SODA API pattern:
  GET https://apd-data.albanyny.gov/resource/{dataset_id}.json
    ?$where=date_column > '2026-01-01'
    &$order=date_column DESC
    &$limit=1000
    &$offset=0

Notes:
  - FBI UCR Hierarchy Rule applied — only highest offense per incident
  - Geocoded to neighborhood/zone level, not exact address (privacy by design)
  - Arrests dataset is YTD, updated near-daily
  - Crime data is preliminary and subject to monthly revision
  - APD uses CopLogic (MyPDConnect) for citizen online reports:
    https://albanypd.mypdconnect.com/ — non-emergency incidents filed here
    do not generate scanner traffic; they do eventually appear in Socrata datasets

Integration priority: CRITICAL — largest missing structured source

### 1.2 NYSP TROOP G — Daily Public Blotter PDFs
Base URL: https://publicapps.troopers.ny.gov/Media_Reports/
Format: PDF, published twice daily, seven days per week
Naming pattern: /media/TroopG/Media{Day}{Shift}.pdf

All valid URLs:
  Mon:  /media/TroopG/MediaMon1.pdf  /media/TroopG/MediaMon2.pdf
  Tue:  /media/TroopG/MediaTue1.pdf  /media/TroopG/MediaTue2.pdf
  Wed:  /media/TroopG/MediaWed1.pdf  /media/TroopG/MediaWed2.pdf
  Thu:  /media/TroopG/MediaThu1.pdf  /media/TroopG/MediaThu2.pdf
  Fri:  /media/TroopG/MediaFri1.pdf  /media/TroopG/MediaFri2.pdf
  Sat:  /media/TroopG/MediaSat1.pdf  /media/TroopG/MediaSat2.pdf
  Sun:  /media/TroopG/MediaSun1.pdf  /media/TroopG/MediaSun2.pdf

Confirmed fields per record:
  - Incident number (e.g., NY2600087206)
  - Incident category (e.g., Burglary, DWI, Assault)
  - Date/time reported
  - Station (LATHAM, GUILDERLAND, NEW SCOTLAND, WESTERLO, etc.)
  - Location code (e.g., TOWN - GUILDERLAND - 0155, TOWN - WESTERLO - 0163)
  - Incident status (Arrest adult, Arrest juvenile, Report only, etc.)
  - Defendant name, age, address (CITY, State format)
  - Date/time of arrest
  - Arraignment status and bail
  - Penal Law section, subsection, class, description, count

Albany County location codes observed:
  - TOWN - GUILDERLAND - 0155
  - TOWN - COLONIE - 0153
  - TOWN - BERNE - (verify code)
  - TOWN - KNOX - (verify code)
  - TOWN - NEW SCOTLAND - (verify code)
  - TOWN - WESTERLO - 0163
  - TOWN - RENSSELAERVILLE - (verify code)

Parsing: pdfplumber or PyMuPDF recommended

Integration priority: CRITICAL — only automated source for rural Albany County
  towns (Berne, Knox, New Scotland, Rensselaerville, Westerlo)

### 1.3 NYSP NEWSROOM — Press Releases
URL: https://troopers.ny.gov/nysp-newsroom
Pagination: ?page=N
Format: HTML, no native RSS confirmed; requires scraping
Frequency: Multiple per day statewide; several per week relevant to Albany County

Filter keywords: Albany, Colonie, Guilderland, Bethlehem, New Scotland, Westerlo,
  Knox, Berne, Rensselaerville, Latham, Delmar, Coeymans, Ravena, Green Island,
  Cohoes, Watervliet, Menands, Altamont

Content type: Significant arrests, fatality crashes, major investigations

Integration priority: HIGH

### 1.4 Albany County Sheriff's Office — Press Releases
URL: https://www.albanycountyny.gov/government/departments/county-sheriff
Archive: https://www.albanycountyny.gov/our-county/county-news (filter Sheriff)
Facebook: https://www.facebook.com/AlbanyCountySheriff (near-daily posting)
Twitter/X: Active
Phone: (518) 487-5400
Non-emergency dispatch: (518) 765-2351

Content: All ACSO patrol areas (Berne, Knox, New Scotland, Rensselaerville,
  Westerlo), Airport station, major drug/gun operations, DWI task force

Integration priority: HIGH

### 1.5 Albany City Police Department — Press Releases and Social
URL: https://www.albanyny.gov/348/Albany-Police
Facebook: https://www.facebook.com/AlbanyNYPolice (70,000+ followers)
Twitter/X: @AlbanyNYPolice
Nextdoor: https://nextdoor.com/agency-detail/ny/albany/albany-police-department-4/
  (2,700+ posts archived; same content as Nixle/Facebook but sometimes faster)
Nixle: https://local.nixle.com/albany-police-department (CONFIRMED ACTIVE)

Integration priority: HIGH

### 1.6 Albany County District Attorney — Press Office
URL: https://www.albanycountyny.gov/government/albany-county-district-attorney/press-office
DA: Lee C. Kindlon (sworn January 2025)
Phone: (518) 487-5460
Crime tips: DATips@albanycountyny.gov

Content: Indictments, convictions, sentences — case disposition data that closes
  the loop on arrests tracked in the app

Integration priority: HIGH

### 1.7 Municipal PD Websites — Press Releases and Annual Reports

Guilderland PD:
  Site: https://www.guilderlandpd.org
  Annual reports: Available on site
  Nixle: https://local.nixle.com/guilderland-police-department (CONFIRMED ACTIVE)
    - Publishes full arrest press releases with defendant/charges/bail/judge
    - Text-a-tip: TIP ALERTMEGPD to 888-777
  Town press releases: https://townofguilderland.org/CivicAlerts.aspx?CID=12
    (CivicEngage CMS; RSS may be at /RSSFeed.aspx?type=CivicAlerts&CAID=12)
  Non-emergency: (518) 356-1501

Bethlehem PD:
  Site: https://www.townofbethlehem.org/142/Police
  Annual reports: 2013-2025 confirmed available
  Facebook: https://www.facebook.com/PDBethlehem/
  Non-emergency: (518) 439-9973
  42 sworn, accredited since 1990

Colonie PD:
  Site: https://www.townofcolonie.gov/departments/police
  Facebook: https://www.facebook.com/ColoniePD/
  Non-emergency: (518) 783-2744
  Community Services: (518) 782-2662
  115 sworn, accredited since 1994

Cohoes PD:
  Site: https://www.cohoes-ny.gov/534/Police-Department
  Facebook: Active (arrest alerts faster than media pickup)
  Non-emergency: (518) 237-5333

Watervliet PD:
  Site: https://www.watervlietny.gov (verify)
  Facebook: Active
  Nixle: City of Watervliet confirmed active; keyword VLIET
  Non-emergency: (518) 270-3833

Green Island PD:
  Facebook: Active
  Non-emergency: (518) 273-2401

Menands PD:
  Non-emergency: (518) 463-1681
  Dispatched by Colonie PD Communications

Coeymans PD:
  Recent Arrests page: https://www.coeymans.org/news-notice/recent-arrests/
    (Weekly list of names, charges, dates, arraignment details — VERIFIED)
  Non-emergency: (518) 756-2059

Altamont Village PD:
  Non-emergency: (518) 861-5480
  115 Main Street, P.O. Box 643, Altamont, NY 12009

Integration priority: HIGH for Facebook/Nixle monitoring; MEDIUM for annual stats

### 1.8 University at Albany Police Department (UAPD)
Main site: https://police.albany.edu
Searchable incident database: https://police.albany.edu/IETS/UPD_All_Incidents.aspx
Statistics and records: https://www.albany.edu/police/statistics-and-records
Clery Act compliance: https://www.albany.edu/police/clery-act-compliance
Make a report: https://www.albany.edu/police/make-report
Phone: (518) 442-3131

DAILY REPORT EMAIL LISTSERV (NEW — HIGH VALUE):
  Subscribe by emailing: listserv@listserv.albany.edu
  Leave subject blank; body: SUBSCRIBE UPD-DAILY-REPORT
  Source page: https://police.albany.edu/DailyRptEmail.shtml
  Content: Daily compiled campus crime/incident log, business days only
  Format: Email; parse for offense type, date, location, case status
  This is the Clery-compliant daily crime log, published by federal law

44 sworn officers, accredited since 2011

Integration priority: MEDIUM — automated via listserv subscription

### 1.9 OffenderWatch / SheriffAlerts — Albany County Sex Offender Registry
Albany County Sheriff OffenderWatch:
  Primary URL: https://www.sheriffalerts.com/albany.php
  Alternate URL: https://www.communitynotification.com/albany.php
  Both confirmed active and operated by ACSO
  Updated instantaneously as offenders register or change addresses

Albany City PD OffenderWatch:
  URL: https://www.icrimewatch.net/index.php?AgencyID=54667

Guilderland PD OffenderWatch:
  Referenced at: https://www.guilderlandpd.org/sex-offenders

Colonie PD OffenderWatch:
  Referenced at Colonie PD site (verify URL)

More current than DCJS monthly data; includes photos; Level 2 and 3 only

Integration method: Scrape ACSO portal for county-wide data; subscribe to
  email alerts via OffenderWatch resident registration for real-time updates

Integration priority: MEDIUM

========================================================================
## SECTION 2 — LOCAL MEDIA RSS FEEDS AND SCRAPE TARGETS
========================================================================

### 2.1 CBS6 / WRGB (Sinclair Broadcast Group) — CRITICAL
Site: https://cbs6albany.com
Local/crime section: https://cbs6albany.com/news/local
RSS feed: https://cbs6albany.com/feed/

Coverage strength: Strongest TV news presence for Albany County crime.
  Same-day APD/ACSO press release pickup. Covers Bethlehem, Colonie,
  Guilderland, Cohoes, Watervliet. Publishes APD quarterly crime stats directly.
  Published Albany Violence Prevention Task Force report (Aug 2025).
  Q1 2026 Albany crime stats published April 2026.

Update frequency: Continuous breaking, multiple stories per day

Integration priority: CRITICAL

### 2.2 NEWS10 ABC / WTEN (Gray Television) — CRITICAL
Site: https://www.news10.com
Crime section: https://www.news10.com/news/crime/
RSS feed: https://www.news10.com/feed/

Coverage strength: Broad Capital Region; strong Albany County crime coverage;
  frequent NYSP press release pickup

Update frequency: Continuous

Integration priority: CRITICAL

### 2.3 WNYT NewsChannel 13 (Nexstar Media) — HIGH
Site: https://wnyt.com
Crime tag: https://wnyt.com/tag/crime/
Top stories: https://wnyt.com/category/top-stories/
RSS feed: https://wnyt.com/feed/ (verify availability)
Investigates unit: https://wnyt.com/investigates/
News Director: Josh Koumjian — jkoumjian@wnyt.com — (518) 207-4715
Address: 715 N. Pearl St., Albany, NY 12204

Coverage strength: Strong local crime desk; 13 Investigates for long-form
  public safety reporting; NYSP and Albany County Sheriff regular sources

Update frequency: Continuous

Integration priority: HIGH

### 2.4 Spectrum News 1 Capital Region (Charter Communications) — HIGH
Site: https://spectrumlocalnews.com/nys/capital-region
Public safety: https://spectrumlocalnews.com/nys/capital-region/public-safety
RSS feed: https://spectrumlocalnews.com/services/contentaggregator/nys/capital-region/news.rss

Coverage strength: 24/7 local news; good DA/court outcomes coverage

Update frequency: Continuous

Integration priority: HIGH

### 2.5 Times Union (Hearst Newspapers) — CRITICAL
Site: https://www.timesunion.com
Local news: https://www.timesunion.com/news/
RSS feed: https://timesunion.com/news/feed/Local-news (verify exact path)

Coverage strength: Flagship Albany County newspaper since 1856; deepest
  investigative coverage; court records, DA office, police accountability;
  primary source for detailed crime narratives

Note: Some content behind paywall; scraping headlines/abstracts still
  valuable for incident signals

Update frequency: Continuous digital, daily print

Integration priority: CRITICAL

### 2.6 Daily Gazette / Spotlight News (Gazette News Group) — CRITICAL
Main site: https://www.dailygazette.com
Spotlight News: https://spotlightnews.com
Crime section: https://spotlightnews.com/crime-and-police/
Weekly Colonie blotter: https://spotlightnews.com/tag/colonie-police/
Bethlehem coverage: https://spotlightnews.com/towns/bethlehem/
Guilderland: https://spotlightnews.com/towns/guilderland/
New Scotland: https://spotlightnews.com/towns/new-scotland/
RSS: https://www.dailygazette.com/rss/ (verify crime section)

Coverage strength: HIGHEST VALUE for suburban Albany County. Spotlight News
  publishes the Colonie area weekly police blotter — most detailed public
  document available for Colonie PD, Guilderland PD, and Bethlehem PD
  incidents short of direct FOIL requests. Published weekly with individual
  incident narratives, charges, and defendants by name.

Update frequency: Weekly blotter + continuous breaking news

Integration priority: CRITICAL for Colonie/Bethlehem/Guilderland coverage

### 2.7 Altamont Enterprise — HIGH (western hill towns)
Site: https://altamontenterprise.com
RSS feed: https://altamontenterprise.com/feed/ (verify)
Tag: arrest — https://altamontenterprise.com/tags/arrest (PUBLIC)
Tag: DWI — https://altamontenterprise.com/tags/dwi (PUBLIC)
Tag: Guilderland PD — https://altamontenterprise.com/tags/guilderland-police-department (PUBLIC)

IMPORTANT CAVEAT: Blotter page (https://altamontenterprise.com/community/blotters)
  requires digital subscriber login AND blotters are removed after one week.
  Do NOT attempt to scrape the blotter page without a subscription.
  
Instead scrape: public tag pages and individual articles which remain accessible.
  Content confirmed: full arrest narratives with defendant/charges/agency/arraignment.

Coverage: Berne, Knox, New Scotland, Rensselaerville, Westerlo (ACSO primary),
  Altamont Village PD, Guilderland PD, Bethlehem PD, NYSP Troop G in western
  Albany County. Only media source regularly covering the five hill towns.

Integration priority: HIGH for tag/article scraping

### 2.8 WAMC Northeast Public Radio — MEDIUM
Site: https://www.wamc.org
RSS: https://www.wamc.org/rss.xml
Troop G tag: https://www.wamc.org/tags/new-york-state-police-troop-g

Coverage: In-depth public safety reporting; major cases, court outcomes, policy

Integration priority: MEDIUM

### 2.9 Albany Proper — MEDIUM
Site: https://www.albanyproper.com
RSS: https://www.albanyproper.com/feed/
Open data: https://www.albanyproper.com/albany-proper-open-data/

Coverage: Civic journalism; data-driven public safety reporting

Integration priority: MEDIUM

### 2.10 All Over Albany — MEDIUM
Site: https://alloveralbany.com

Coverage: Hyperlocal civic; analysis of APD open data; neighborhood-level

Integration priority: MEDIUM

### 2.11 Patch — Town-Specific Editions — HIGH
Albany: https://patch.com/new-york/albany/police-fire
Colonie: https://patch.com/new-york/colonie/police-fire
Bethlehem: https://patch.com/new-york/bethlehem-ny/police-fire
Guilderland: https://patch.com/new-york/guilderland/police-fire
Cohoes: https://patch.com/new-york/cohoes/police-fire
Delmar: https://patch.com/new-york/delmar/police-fire
Latham: https://patch.com/new-york/latham/police-fire
Watervliet: https://patch.com/new-york/watervliet (verify)

RSS pattern: https://patch.com/new-york/{town-slug}/feed

Coverage: Town-level police blotters, some syndicated directly from PDs

Integration priority: HIGH for town-level coverage

### 2.12 FOX23 Albany / WXXA (Nexstar) — LOW
Site: https://foxalbany.com (verify current domain)
Coverage: Supplemental TV news
Integration priority: LOW — supplemental

========================================================================
## SECTION 3 — STATISTICAL / TREND DATA SOURCES
========================================================================

### 3.1 NY DCJS Criminal Justice Statistics Portal
Main URL: https://www.criminaljustice.ny.gov/crimnet/ojsa/stats.htm

GIVE Greenbook (HIGHEST VALUE — monthly gun violence data):
  URL: https://www.criminaljustice.ny.gov/crimnet/ojsa/greenbook.pdf
  Published: Monthly
  Albany PD section: Pages labeled "300" in document
  Contains per-month for Albany City PD:
    - Shooting incidents with injury or death
    - Shooting victims (persons hit)
    - Individuals killed by gun violence
    - Crime by category (murder, rape, robbery, aggravated assault) YTD
    - Domestic violence data by offense type
    - Arrest data by category
  Albany is a GIVE Tier 1 jurisdiction — this is the most current public
  gun violence data available for Albany City.

Other DCJS resources:
  Index Crime by Agency:              Annual (December)
  Hate Crime by County/Agency:        Annual (December)
  Domestic Violence Data:             Annual
  Case Level Incidents by Agency:     Annual (through Dec 2024 as of 2025)
  GIVE Initiative overview:           https://www.criminaljustice.ny.gov/ops/gunviolencereduction/index.htm
  DCJS Press Releases:                https://www.criminaljustice.ny.gov/pio/press_releases/
  NY Open Data DCJS datasets:         https://data.ny.gov (search "Division of Criminal Justice")

Integration priority: HIGH for monthly greenbook; MEDIUM for annual reports

### 3.2 FBI Crime Data Explorer (CDE)
URL: https://cde.ucr.cjis.gov
API base: https://api.usa.gov/crime/fbi/cde/
API key registration: https://api.data.gov/signup/ (free)

Albany County Agency ORIs:
  Albany City PD:        NY0010100
  Albany County Sheriff: NY0010000
  Colonie Town PD:       NY0010300
  Bethlehem Town PD:     NY0010200
  Guilderland Town PD:   NY0010600 (verify)
  Cohoes City PD:        NY0010400 (verify)
  Watervliet City PD:    NY0011100 (verify)
  UAPD:                  NY0010700 (verify)

API example:
  GET https://api.usa.gov/crime/fbi/cde/offenses/count/national/NY0010100/violent-crime/2015/2023?api_key={key}

Integration priority: MEDIUM — partially implemented; expand to all county ORIs

### 3.3 NY Open Data Portal
URL: https://data.ny.gov
Platform: Socrata — same SODA API pattern as APD portal
Relevant: "adult arrests county", "index crimes", "sex offender" datasets

SODA pattern:
  GET https://data.ny.gov/resource/{dataset_id}.json?county=Albany&$limit=1000

Integration priority: MEDIUM

========================================================================
## SECTION 4 — SCANNER AND RADIO SOURCES
========================================================================

### 4.1 Broadcastify Feeds — Complete Albany County List

Feed ID  | Name                                          | Priority
---------|-----------------------------------------------|----------
3626     | Albany City and Colonie Police, Fire, EMS     | Already integrated
38372    | Albany Police (dedicated APD feed)            | Add if not present
36327    | Bethlehem Public Safety (PD + Fire + EMS)     | Add
37206    | Albany County Volunteer Fire Depts            | Add
1440     | Albany City Fire                              | Add
21216    | NYS Thruway Authority - Albany Division       | Add
39065    | Maplewood VFD                                 | Low priority
45393    | CSX Selkirk Sub                               | Optional
45385    | CSX Selkirk Terminal                          | Optional

Broadcastify Calls public playlists:
  Albany County Public Safety:
    https://www.broadcastify.com/calls/playlists/?uuid=425db81f-efc3-11ef-9e04-0e98d5b32039
  Albany County Fire/EMS:
    https://www.broadcastify.com/calls/playlists/?uuid=9b23ee55-efc3-11ef-9e04-0e98d5b32039

Broadcastify Calls coverage for Albany County:
  Law Dispatch: 17 talkgroups
  Law Talk: 4 talkgroups
  Fire Dispatch: 11 talkgroups
  Fire-Tac: 10 talkgroups
  EMS Dispatch: 10 talkgroups
  Emergency Ops: 2 talkgroups
  Interop: 6 talkgroups
  Multi-Tac: 2 talkgroups
  Public Works: 18 talkgroups
  Schools: 5 talkgroups
  Security: 7 talkgroups
  Transportation: 1 talkgroup
  Utilities: 2 talkgroups

### 4.2 OpenMHz
URL: https://openmhz.com/system/albanycony
API: https://api.openmhz.com/ (public, documented)
Usage: Searchable historical call recordings; query by talkgroup, date, duration

P25 Talkgroup-to-Agency Mapping (use for entity extraction):
  Talkgroup 31-37, 39 = Albany County Sheriff (multiple channels)
  Talkgroup 58        = Albany County Sheriff / County Law Enforcement
  Talkgroup 59        = Coeymans Town Police Department
  Talkgroup 62        = Cohoes Law Enforcement (PD + Animal Control + Code Enforcement)
  Talkgroup 76        = Green Island Village Police Department
  Talkgroup 98        = Watervliet City Police Department

Note: Talkgroup 62 for Cohoes encompasses Animal Control and Code Enforcement
  in addition to the Police Department — use for entity disambiguation.

========================================================================
## SECTION 5 — NIXLE CONFIRMED ACTIVE AGENCIES (NEW — PREVIOUSLY UNCONFIRMED)
========================================================================

Nixle is owned by Everbridge. Albany City actively directs residents to Nixle
for neighborhood alerts. No public API — scrape public message archive pages.

Albany County Nixle county portal:
  https://local.nixle.com/county/ny/albany/
  Lists all Albany County municipalities with Nixle coverage.

Albany city Nixle portal:
  https://local.nixle.com/city/ny/albany/
  Lists: Bethlehem, Colonie (Town), Guilderland, Hampton Manor, Menands, New Scotland

Agency Nixle URL pattern: https://local.nixle.com/{agency-name-hyphenated}

Confirmed active agency pages:
  Albany Police Department:    https://local.nixle.com/albany-police-department
  Guilderland PD:              https://local.nixle.com/guilderland-police-department
  Town of Guilderland:         https://local.nixle.com/town-of-guilderland-ny
  City of Watervliet:          Confirmed active (keyword: VLIET to 888-777)

Agencies to verify (check URL pattern):
  Albany County Sheriff:       https://local.nixle.com/albany-county-sheriffs-office
  Colonie PD:                  https://local.nixle.com/colonie-police-department
  Bethlehem PD:                https://local.nixle.com/bethlehem-police-department
  Cohoes PD:                   https://local.nixle.com/cohoes-police-department
  Green Island PD:             https://local.nixle.com/green-island-police-department
  Menands PD:                  https://local.nixle.com/menands-police-department
  Coeymans PD:                 https://local.nixle.com/coeymans-police-department

Text-a-tip keywords:
  Guilderland PD: TIP ALERTMEGPD to 888-777
  Watervliet: TIP VLIET to 888-777
  Albany County general: ZIP code to 888-777

Integration method: Scrape each agency's public message page (HTML, consistent
  structure). Alert type, date, location, body text are extractable.
  Guilderland PD confirmed publishing full arrest press releases including
  defendant name, charges, bail amount, and arraignment judge.

Integration priority: HIGH — fills Guilderland PD and Watervliet PD gap

========================================================================
## SECTION 6 — GIS AND GEOCODING REFERENCE DATA
========================================================================

(Not incident sources — critical for locality confidence scoring and
 jurisdiction boundary determination)

Albany City GIS Hub (ArcGIS):
  URL: https://city-albanyny-gis.hub.arcgis.com/
  Content: Parcel data, ward boundaries, neighborhood boundaries,
           street centerlines, zoning layers
  API: ArcGIS REST API available for all layers
  Use: Albany city neighborhood boundary determination and
       address-to-neighborhood mapping
  Integration priority: HIGH

Albany County GIS (NYS Clearinghouse):
  URL: https://data.gis.ny.gov/datasets/AlbCountyGIS::albany-county-gis
  Tax Parcels 2025: https://data.gis.ny.gov/maps/AlbCountyGIS::albany-county-tax-parcels-2025/about
  GIS info page: https://www.albanycountyny.gov/departments/economic-development-conservation-and-planning/mapping
  Content: Tax parcel boundaries, municipality boundaries, road networks, address points
  Use: County-wide municipality boundary determination; jurisdiction assignment
       for incidents in unincorporated areas and border zones
  Integration priority: HIGH

Albany County Image Mate / Property Assessment:
  URL: https://albany.sdgnys.com/
  Content: Tax parcels, assessment data, property images, tax maps
  2025 Final Assessment Roll now available
  Integration priority: LOW for incident tracking; MEDIUM for address geocoding

NYS GIS Clearinghouse:
  URL: https://data.gis.ny.gov/
  Relevant layers: Municipal boundaries statewide, NYS road network, E-911 address points
  Integration priority: MEDIUM

========================================================================
## SECTION 7 — SUPPLEMENTAL OFFICIAL SOURCES
========================================================================

NY WebCrims — Free Criminal Court Case Lookup:
  URL: https://iapps.courts.state.ny.gov/webcrim_attorney/Login
  Guest access available
  Scope: Albany City Court, Albany County Court criminal cases
  Use: Verify charges, dispositions, bail status

NYSCEF — NYS Courts Electronic Filing:
  URL: https://iapps.courts.state.ny.us/nyscef/CaseSearch
  Guest search available without account
  Scope: Albany County Supreme Court, Albany County Court felony cases
  Use: Access indictments and felony case documents

Albany County DA Press Office:
  URL: https://www.albanycountyny.gov/government/albany-county-district-attorney/press-office
  DA: Lee C. Kindlon
  Phone: (518) 487-5460
  Content: Indictments, convictions, sentences for all Albany County jurisdictions

Albany County Correctional Facility — Inmate Lookup:
  URL: https://www.albanycountyny.gov/government/county-sheriff/corrections
  Check for public inmate lookup portal
  Use: Verify custody status of defendants

NYS Sex Offender Registry:
  URL: https://www.criminaljustice.ny.gov/SomsSUBDirectory/Search.jsp
  Level 2 and 3 only; searchable by county
  Update frequency: Monthly (OffenderWatch is more current)

FBI Albany Field Office — Press Releases:
  URL: https://www.fbi.gov/contact-us/field-offices/albany/news
  Covers: Federal cases originating in Albany County — child exploitation,
          violent crime, public corruption, cybercrime
  Covers 32 counties in northern NY and all of Vermont

US Attorney NDNY — Press Releases:
  URL: https://www.justice.gov/usao-ndny/news
  Covers: Federal indictments and convictions for Albany County defendants

Crash Report Portals (traffic enrichment):
  CrashDocs (Albany PD and Guilderland PD post-July 2018):
    URL: https://www.crashdocs.org/
    APD directs all MV accident report requests here (confirmed on official site)
  LexisNexis BuyCrash (pre-2018 and some agencies):
    URL: https://policereports.lexisnexis.com/
  NY DMV / CODES crash data (statistical):
    URL: https://www.health.ny.gov/statistics/prevention/injury_prevention/traffic/county/albany/index.htm
  Integration priority: LOW for direct data pull; note as verification source

========================================================================
## SECTION 8 — MULTI-AGENCY TASK FORCES (normalize to participating agencies)
========================================================================

Task forces do not operate independently but generate press releases and scanner
traffic under their own names. Normalize to the primary participating agency.

Capital District Drug Enforcement Task Force:
  Lead: NYSP Troop G / DEA Albany
  Members: Albany PD, ACSO, Colonie PD, Guilderland PD, Bethlehem PD, others
  Normalize to: NYSP Troop G or named primary arresting agency

FBI Child Exploitation Task Force (Albany):
  Lead: FBI Albany Field Office
  Members: Town of Colonie PD (Computer Crimes Unit), NYSP
  Colonie PD Computer Crimes Unit is an active member

NYS ICAC Task Force:
  Lead: New York State Police
  Members: Colonie PD Computer Crimes Unit and others
  Overlaps with FBI CETF

US Marshals Regional Fugitive Task Force (NY/NJ):
  Lead: USMS Northern District of NY
  Normalize to: USMS with local agency participation noted

Albany County DWI Enforcement Task Force:
  Lead: Albany County Sheriff's Office (STOP-DWI Unit)
  Members: All Albany County local PDs
  STOP-DWI phone: (518) 720-8100
  Normalize to: Arresting agency listed in report

Capital District Violent Felony Warrant Squad:
  Lead: Typically NYSP and/or ACSO
  Members: Albany PD, ACSO, Colonie PD, others
  Normalize to: Lead agency for specific operation

Joint Terrorism Task Force (JTTF) — Albany:
  Lead: FBI Albany Field Office
  Members: NYSP (Counter Terrorism Unit, NYSIC), ACSO, Albany PD, federal agencies
  Note: Rarely generates local scanner traffic; marginal for routine crime tracking

Capital Region Hazmat Team (law enforcement component):
  Radio identifier: 4961 (HazMat 1), 4962 (second piece/reserve)
  Lead: Albany County Sheriff (Fire Coordinators Unit)
  Normalize to: ACSO with fire and EMS partners noted

========================================================================
## SECTION 9 — DISPATCH AND PSAP REFERENCE
========================================================================

Primary PSAP for Albany County E-911:
  Albany County Sheriff's Office Communications Center
  Non-emergency: (518) 765-2351
  Dispatches: ACSO patrol, NYSP (Troop G zones), Cohoes PD, Watervliet PD,
    Green Island PD, Coeymans PD, 10 volunteer fire companies,
    5 ambulance companies, Albany County Highway, Albany County Probation

Colonie PD Communications (separate PSAP):
  Dispatches: Colonie PD, Menands PD, Colonie Fire, Colonie EMS
  One of six PSAPs in Albany County

Albany City Police Department Communications (separate PSAP):
  Dispatches: Albany City PD units only

Guilderland PD: Verify dispatch method (may use ACSO or internal)
Bethlehem PD: Verify dispatch method
Altamont Village PD: Likely dispatched by ACSO (verify)
Coeymans PD: ACSO E-911 (confirmed)
Cohoes PD: ACSO E-911 (confirmed)
Watervliet PD: ACSO E-911 (confirmed)
Green Island PD: ACSO E-911 (confirmed)

Six total PSAPs in Albany County:
  1. ACSO E-911 (primary, county-wide)
  2. Albany City PD Communications
  3. Colonie PD Communications
  4. Bethlehem PD (verify)
  5. Guilderland PD (verify)
  6. Menands PD (secondary, receives from Colonie)

========================================================================
## SECTION 10 — MUNICIPALITY COVERAGE GAPS
========================================================================

Municipalities with NO municipal police department — covered by ACSO and NYSP:
  Town of Berne
  Town of Knox
  Town of New Scotland
  Town of Rensselaerville
  Town of Westerlo
  Village of Voorheesville (NYSP and ACSO)
  Village of Colonie (small village; ACSO/NYSP)

Incidents from these municipalities should default locality to:
  primary_agency: albany-county-sheriff OR nysp-troop-g
  Dispatch zone: ACSO E-911

Note on Village of Ravena: covered by Town of Coeymans PD
Note on Village of Altamont: has own PD (Altamont Village PD); separate
  from Guilderland Town PD which covers the surrounding town

========================================================================
## SECTION 11 — SOURCE IMPLEMENTATION PRIORITY ORDER
========================================================================

Priority | Source                                    | Gap filled
---------|-------------------------------------------|------------------------------------------
1        | APD Open Data / Socrata API               | Structured incident/arrest data Albany City
2        | NYSP Troop G daily blotter PDFs           | Rural towns — only automated source
3        | Spotlight News / Daily Gazette scrape     | Colonie/Bethlehem/Guilderland weekly blotter
4        | CBS6 RSS                                  | Highest-volume verified crime narrative
5        | NEWS10 RSS                                | Second TV source, Capital Region coverage
6        | Times Union RSS                           | Deepest investigative and court coverage
7        | WNYT RSS / scrape                         | Third TV source, 13 Investigates
8        | Spectrum News RSS                         | 24/7 coverage, DA/court outcomes
9        | Nixle agency scraping (Guilderland, WPD) | Arrest notices faster than media pickup
10       | Albany DA press office scrape            | Case disposition data
11       | ACSO press release scrape                | All ACSO patrol area incidents
12       | DCJS GIVE Greenbook PDF (monthly)        | Most current gun violence data Albany City
13       | Albany City GIS ArcGIS API               | Locality confidence / geocoding
14       | Albany County GIS boundary data          | Jurisdiction assignment county-wide
15       | Broadcastify feeds 38372, 36327          | Additional scanner feeds
16       | Altamont Enterprise tag scraping         | Western hill town coverage
17       | UAPD listserv daily report               | Campus crime log
18       | ACSO OffenderWatch scrape                | Real-time sex offender changes
19       | Patch town editions                      | Town-level blotter aggregation
20       | Guilderland Town CivicEngage             | Supplemental Guilderland PD
21       | WAMC RSS                                 | In-depth public safety reporting
22       | FBI Albany press releases                | Federal case outcomes
23       | USAO NDNY press releases                 | Federal prosecution outcomes

========================================================================
## SECTION 12 — SOURCES CONFIRMED NOT AVAILABLE OR LOW SIGNAL
========================================================================

Albany County 911 CAD data: Not public; no API or release mechanism;
  scanner audio is the proxy for real-time dispatch data

Daily Gazette main site (dailygazette.com): Paywalled; Spotlight News
  (same company, free) is the better target

PACER (federal court): Paid per page, no push notifications;
  use USAO NDNY press releases as free proxy

Albany County Clerk criminal records online: Requires in-person or FOIL;
  not suitable for automation

Albany City Common Council public safety minutes: HTML, irregular;
  useful for context but low signal for real-time incident tracking

FOX23/WXXA: Largely duplicates coverage of CBS6/NEWS10/WNYT; LOW marginal value

CopLogic citizen reports (albanypd.mypdconnect.com): Not a feed;
  citizen-filed non-emergency reports; they eventually appear in Socrata data
