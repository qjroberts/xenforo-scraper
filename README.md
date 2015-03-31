xenforo-scraper
========================================

Scrape a single XenForo forum and save it to a sqlite3 database.

This is a quick and dirty script used to back up the Lore and General Discussion forums on the [EverQuest Next](https://forums.station.sony.com/everquestnext) forums before they were removed.

## Requirements
This script requires Node 0.10.33 or higher (I've only tested with Node 0.10.33).

## Running the Scraper

1. Modify the `xf-scraper.js` script to point to the correct forum.
2. Run the node script.

    ```bash
    node xf-scraper.js
    ```
