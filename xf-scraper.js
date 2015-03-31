/**
 * xenforo-scraper
 * @description Scrape a single XenForo forum.
 */
'use strict';

var path = require('path');
var util = require('util');

var BPromise = require('bluebird');
var cheerio = require('cheerio');
var needle = require('needle');
var sqlite3 = require('sqlite3').verbose();

BPromise.promisifyAll(needle);
BPromise.promisifyAll(sqlite3);

// Keep track of posts/threads/forums for stats
var forumCount = 0,
  threadCount = 0,
  postCount = 0;

/**
 * @class XFPage
 * @description Base class for a XenForo page.
 * @param {object} options - Options to pass for the page
 * @param {object} options.db - The database to pass around to store data
 * @param {string} options.baseUrl - The base URL for every XenForo site
 * @param {string} options.path - The path to append to the baseUrl for the page
 * @param {number} [options.page] - The page to start scraping (Default: 1)
 */
function XFPage(options) {
  // Set up default options
  options = options || {};
  this.db = options.db;
  this.baseUrl = options.baseUrl;
  this.url = this.baseUrl + options.path;
  this.page = options.page || 1;

  // Make sure to follow redirects and appear as Chrome so we don't get booted
  this.clientOpts = {
    followRedirect: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; WOW64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/41.0.2272.89 Safari/537.36'
    }
  };
}

/**
 * @method XFPage#load
 * @description Load a single web page.
 */
XFPage.prototype.load = function load() {
  var url = this.url;

  // Add the page slug for subsequent pages (page 1 doesn't have a slug)
  if (this.page > 1) {
    url += 'page-' + this.page;
  }

  // Fetch the page
  return needle.getAsync(url, this.clientOpts)
    .then(this._onLoad.bind(this));
};

/**
 * @method XFPage#scrape
 * @description Scrape the web page for appropriate data. This is overwritten for each page type.
 */
XFPage.prototype.scrape = function scrape() {
  return BPromise.resolve();
};

/**
 * @method XFPage#archive
 * @description Archive the XenForo page. This is typically overwritten as needed.
 */
XFPage.prototype.archive = function archive() {
  // Let the user know what's going on
  console.log('[%s] Archiving %s (Page %s)',
    this.constructor.name,
    this.url,
    this.page);

  // Load the current page, and then continue to the next page.
  return this.load()
    .then(this._archiveNextPage.bind(this));
};

/**
 * @method XFPage#_archiveNextPage
 * @private
 * @description Archive each subsequent page if we haven't reached the end.
 */
XFPage.prototype._archiveNextPage = function _archiveNextPage() {
  return (this.page === null ? BPromise.resolve() : this.archive());
};

/**
 * @method XFPage#_archiveItem
 * @private
 * @description Archive a single item using it's archive function.
 * @param {object} item - An item with an `archive` function.
 */
XFPage.prototype._archiveItem = function _archiveItem(item) {
  return item.archive();
};

/**
 * @method XFPage#_onLoad
 * @private
 * @description Actions to execute when the page loads
 * @param {object} res - The response from the page load
 */
XFPage.prototype._onLoad = function _onLoad(res) {
  // Set the raw response data (typically a string)
  this._raw = res[1];

  // Parse the string into a DOM-like object
  this._parsed = cheerio.load(this._raw);

  // Scrape the data necessary
  return this.scrape();
};



/**
 * @class XFPost
 * @description A message post object from XenForo.
 * @param {object} options - Options to pass for the page.
 * @param {object} options.db - The database to pass around to store data
 * @param {string} options.title - The title of the message's thread
 * @param {string} options.description - The text content of the post
 * @param {date} options.date - The date the post was created
 * @param {string} options.url - The permalink for the post
 * @param {string} options.guid - The unique identified for the post
 * @param {string} options.author - The original author of the post
 * @param {number} options.likes - The number of likes that the post received
 */
function XFPost(options) {
  // Increment the statistics
  postCount += 1;

  // Set options
  this.db = options.db;
  this.title = options.title;
  this.description = options.description;
  this.date = options.date;
  this.link = options.url;
  this.guid = options.guid;
  this.author = options.author;
  this.likes = options.likes;
}

/**
 * @method XFPost#archive
 * @description Archives a single XenForo post.
 */
XFPost.prototype.archive = function archive() {
  // XML output for possible conversion to RSS to import to XenForo
  // var xml = '<item>' +
  //   '<title>' + this.title + '</title>' +
  //   '<description><![CDATA[' + this.description + ']]></description>' +
  //   '<pubDate>' + this.formatDate() + '</pubDate>' +
  //   '<link>' + this.link + '</link>' +
  //   '<guid>' + this.guid + '</guid>' +
  //   '<author>' + this.author + '</author>' +
  //   '<dc:creator>' + this.author + '</dc:creator>' +
  //   '</item>';

  // Persist the data, just in case
  return this._persistData();
};

/**
 * @method XFPost#_persistData
 * @private
 * @description Persist post data to the database.
 */
XFPost.prototype._persistData = function _persistData() {
  // Insert the post data into sqlite3
  var sql = 'INSERT INTO posts ' +
    '(title, description, date, link, guid, author, number, likes) ' +
    'VALUES ($title, $desc, $date, $link, $guid, $author, $num, $likes);';

  return this.db.runAsync(sql, {
      $title: this.title,
      $desc: this.description,
      $date: this.date.toISOString(),
      $link: this.link,
      $guid: this.guid,
      $author: this.author,
      $num: this.number,
      $likes: this.likes
    });
};

/**
 * @class XFThread
 * @extends XFPage
 * @description A forum thread object in XenForo. It works as follows:
 *     1. Load thread page
 *     2. Find thread title
 *     3. Find each post
 *       -> Scrape each post
 *     4. Find next thread page
 *       -> Load next thread page
 * @param {object} options - Options to pass for the page.
 * @param {string} options.title - The title of the message's thread
 */
function XFThread(options) {
  // Call the base constructor
  XFPage.call(this, options);

  // Increment statistics
  threadCount += 1;

  // Set custom properties
  this.title = options.title;
}

// Perform the actual inheritance
util.inherits(XFThread, XFPage);

/**
 * @method XFThread#archive
 * @description Archives data for a XenForo thread.
 */
XFThread.prototype.archive = function archive() {
  // Apply the original archive from XFPage, and then save in the database
  return this.constructor.super_.prototype.archive.apply(this)
    .then(this._persistData.bind(this));
};

/**
 * @method XFThread#scrape
 * @description Scrape a XenForo thread for each post. The data includes:
 *     * Permalink (guid)
 *     * Author
 *     * Date posts
 *     * Content (post body)
 *     * Likes received
 *     * Post number in the thread
 */
XFThread.prototype.scrape = function scrape() {
  // Get the parsed data
  var $ = this._parsed;
  var posts = $('.message')
    .map(function () {
      // Iterate over each message to get the data
      var $this = $(this);
      var likes = $this.find('.dark_postrating_outputlist li > strong').text();
      var $date = $this.find('.DateTime');
      var rawDate = [];

      // Depending on how the date is posted, fetch the date
      if ($date.data('datestring')) {
        rawDate[0] = $date.data('datestring');
        rawDate[1] = $date.data('timestring');
      } else {
        rawDate = $this.find('.DateTime').attr('title').split(' at ');
      }

      // Convert it to an actual date object
      var date = new Date(rawDate[0]);
      var time = rawDate[1].match(/(\d+):(\d+) (\w+)/);

      date.setHours(parseInt(time[1], 10) + (/am/i.test(time[3]) ? 0 : 12));
      date.setMinutes(parseInt(time[2], 10));

      // Return the necessary data
      return {
        permalink: $this.find('datePermalink').attr('href'),
        author: $this.data('author'),
        date: date,
        content: $this.find('blockquote').html(),
        likes: parseInt(likes || 0, 10),
        number: parseInt($this.find('.postNumber').text().replace('#', ''), 10)
      };
    })
    .get() // Convert to an Array
    .map(function (data) {
      // Create new XenForo Post objects, passing necessary data
      return new XFPost({
        db: this.db,
        title: this.title,
        url: this.url,
        guid: this.baseUrl + data.permalink,
        author: data.author,
        date: data.date,
        description: data.content,
        likes: data.likes,
        number: data.number
      });
    }, this);

  // Check if we're at the last page, and if not set the next page to fetch
  var last = $('.PageNav').data('last');
  this.page = (last === undefined || this.page === last ?
    null : this.page + 1);

  // Archive each post individually
  return BPromise.map(posts, this._archiveItem.bind(this));
};

/**
 * @method XFThread#_persistData
 * @private
 * @description Persist post data to the database.
 */
XFPost.prototype._persistData = function _persistData() {
  // Insert the post data into sqlite3
  var sql = 'INSERT INTO threads (title, url) VALUES ($title, $url);';

  return this.db.runAsync(sql, {
      $title: this.title,
      $url: this.url
    });
};

/**
 * @class XFForum
 * @extends XFPage
 * @description A forum object in XenForo. It works as follows:
 *     1. Load page
 *     2. Find all threads
 *       -> Scrape each thread
 *     3. Find next page
 *       -> Load next page
 * @param {object} options - Options to pass for the page.
 */
/**

 */
function XFForum(options) {
  // Call the base constructor
  XFPage.call(this, options);

  // Increment statistics
  forumCount += 1;
}

// Perform the actual inheritance
util.inherits(XFForum, XFPage);

/**
 * @method XFForum#scrape
 * @description Scrape a XenForo thread for each post. The data includes:
 *     * Path (guid)
 *     * Title
 */
XFForum.prototype.scrape = function scrape() {
  // Get the parsed data
  var $ = this._parsed;
  var threads = $('.discussionListItem .title > a')
    .map(function () {
      // Iterate over each thread to get the data
      var $this = $(this);
      return {
        path: $this.attr('href'),
        title: $this.text()
      };
    })
    .get() // Convert to an Array
    .map(function (data) {
      // Create new XenForo Thread objects, passing necessary data
      return new XFThread({
        baseUrl: this.baseUrl,
        path: data.path,
        title: data.title,
        db: this.db
      });
    }, this);

  // Check if we're at the last page, and if not set the next page to fetch
  var last = $('.PageNav').data('last');
  this.page = (last === undefined || this.page === last ?
    null : this.page + 1);

  // Archive each thread individually
  return BPromise.map(threads, this._archiveItem.bind(this));
};


// Set up the archive locally
var db = new sqlite3.Database(path.join(__dirname, '/eqnext-archive.db'));

// Set up the scraper by setting the base and the path to save as well as
// the database to store the information in.
var archiver = new XFForum({
  baseUrl: 'https://forums.station.sony.com/everquestnext/',
  path: 'index.php?forums/eqn-forum-archive-temporary.12/',
  db: db
});

// Create the necessary database tables.
// Yes, this is cheap and hacky. Delete the `eqnext-archive.db` file on fail.
BPromise.all([
    db.runAsync('CREATE TABLE IF NOT EXISTS threads(' +
        'title TEXT NOT NULL, ' +
        'url TEXT NOT NULL ' +
      ');'),
    db.runAsync('CREATE TABLE IF NOT EXISTS posts(' +
        'title TEXT NOT NULL, ' +
        'description TEXT NOT NULL, ' +
        'date TEXT NOT NULL, ' +
        'link TEXT NOT NULL, ' +
        'guid TEXT NOT NULL, ' +
        'author TEXT NOT NULL, ' +
        'number INTEGER NULL, ' +
        'likes TEXT NOT NULL' +
      ');')
  ])
  .then(archiver.archive.bind(archiver)) // Perform the archival
  .then(function () {
    // Output statistics on successful run
    console.log('Archived: %d forums, %d threads, and %d posts',
      forumCount, threadCount, postCount);
  });
