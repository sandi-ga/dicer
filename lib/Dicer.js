var WritableStream = require('stream').Writable
                     || require('readable-stream').Writable,
    inherits = require('util').inherits;

var StreamSearch = require('streamsearch');

var PartStream = require('./PartStream'),
    HeaderParser = require('./HeaderParser');

var B_ONEDASH = new Buffer('-'),
    B_CRLF = new Buffer('\r\n');

function Dicer(cfg) {
  if (!(this instanceof Dicer))
    return new Dicer(cfg);
  WritableStream.call(this, cfg);

  if (!cfg || (!cfg.headerFirst && typeof cfg.boundary !== 'string'))
    throw new TypeError('Boundary required');

  if (typeof cfg.boundary === 'string')
    this.setBoundary(cfg.boundary);
  else
    this._bparser = undefined;

  this._headerFirst = cfg.headerFirst;

  var self = this;

  this._dashes = 0;
  this._parts = 0;
  this._finished = false;
  this._isPreamble = true;
  this._justMatched = false;
  this._firstWrite = true;
  this._inHeader = true;
  this._part = undefined;
  this._cb = undefined;
  this._partOpts = (typeof cfg.partHwm === 'number'
                    ? { highWaterMark: cfg.partHwm }
                    : {});
  this._pause = false;

  this._hparser = new HeaderParser(cfg);
  this._hparser.on('header', function(header) {
    self._inHeader = false;
    self._part.emit('header', header);
  });

}
inherits(Dicer, WritableStream);

Dicer.prototype._write = function(data, encoding, cb) {
  var self = this;

  if (this._headerFirst && this._isPreamble) {
    if (!this._part) {
      this._part = new PartStream(this._partOpts);
      this.emit('preamble', this._part);
    }
    var r = this._hparser.push(data);
    if (!this._inHeader && r !== undefined && r < data.length)
      data = data.slice(r);
    else
      return cb();
  }
    
  // allows for "easier" testing
  if (this._firstWrite) {
    this._bparser.push(B_CRLF);
    this._firstWrite = false;
  }

  this._bparser.push(data);

  if (this._pause)
    this._cb = cb;
  else
    cb();
};

Dicer.prototype.reset = function() {
  this._part = undefined;
  this._bparser = undefined;
  this._hparser = undefined;
};

Dicer.prototype.setBoundary = function(boundary) {
  var self = this;
  this._bparser = new StreamSearch('\r\n--' + boundary);
  this._bparser.on('info', function(isMatch, data, start, end) {
    self._oninfo(isMatch, data, start, end);
  });
};

Dicer.prototype._oninfo = function(isMatch, data, start, end) {
  var buf, self = this, i = 0, r, shouldWriteMore = true;

  if (!this._part && this._justMatched && data) {
    while (this._dashes < 2 && (start + i) < end) {
      if (data[start + i] === 45) {
        ++i;
        ++this._dashes;
      } else {
        if (this._dashes)
          buf = B_ONEDASH;
        this._dashes = 0;
        break;
      }
    }
    if (this._dashes === 2) {
      if ((start + i) < end && this._events.trailer)
        this.emit('trailer', data.slice(start + i, end));
      this.reset();
      this._finished = true;
      //process.nextTick(function() { self.emit('end'); });
    }
    if (this._dashes)
      return;
  }
  if (this._justMatched)
    this._justMatched = false;
  if (!this._part) {
    this._part = new PartStream(this._partOpts);
    this._part._read = function(n) {
      if (!self._pause)
        return;
      self._pause = false;
      if (self._cb) {
        var cb = self._cb;
        self._cb = undefined;
        cb();
      }
    };
    this.emit(this._isPreamble ? 'preamble' : 'part', this._part);
    if (!this._isPreamble)
      this._inHeader = true;
  }
  if (data && start < end) {
    if (this._isPreamble || !this._inHeader) {
      if (buf)
        shouldWriteMore = this._part.push(buf);
      shouldWriteMore = this._part.push(data.slice(start, end));
      if (!shouldWriteMore)
        this._pause = true;
    } else if (!this._isPreamble && this._inHeader) {
      if (buf)
        this._hparser.push(buf);
      r = this._hparser.push(data.slice(start, end));
      if (!this._inHeader && r !== undefined && r < end)
        this._oninfo(false, data, start + r, end);
    }
  }
  if (isMatch) {
    this._hparser.reset();
    if (this._isPreamble)
      this._isPreamble = false;
    else {
      ++this._parts;
      this._part.on('end', function() {
        if (--self._parts === 0 && self._finished) {
          self._finished = false;
          self.emit('end');
        }
      });
    }
    this._part.push(null);
    this._part = undefined;
    this._justMatched = true;
    this._dashes = 0;
  }
};

module.exports = Dicer;
