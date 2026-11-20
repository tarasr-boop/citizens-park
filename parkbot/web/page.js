// Live view for the Citizens Park page.
//
// The page ships with the next few days of bookings and rain as JSON. This
// script works out what "now" is in the park's own time zone and draws the
// answer, so the page stays right through the day, and even if a scheduled
// rebuild is late. It re-reads data.json from time to time for fresh data.
(function () {
  "use strict";

  var holder = document.getElementById("park-data");
  var app = document.getElementById("app");
  if (!holder || !app) return;

  var data;
  try {
    data = JSON.parse(holder.textContent);
  } catch (error) {
    return; // keep the plain version that came with the page
  }

  var NBSP = String.fromCharCode(160);
  var LIKELY = 50;
  var SLIGHT = 20;
  var LAST_RAIN_HOUR = 21;
  // In the rain chart a full-height bar is at least this many millimetres in
  // one hour, so that a drizzle looks like a drizzle.
  var RAIN_FULL_MM = 5;
  var lastFetch = Date.now();
  var shown = "";

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function clock(minutes, withHalf) {
    if (minutes === 0 || minutes === 1440) return "midnight";
    var hour = Math.floor(minutes / 60);
    var minute = minutes % 60;
    var hour12 = hour % 12 || 12;
    var text = minute ? hour12 + ":" + (minute < 10 ? "0" : "") + minute : String(hour12);
    // A non-breaking space keeps "4" and "PM" on the same line.
    return withHalf === false ? text : text + (hour < 12 ? NBSP + "AM" : NBSP + "PM");
  }

  function span(slot) {
    var sameHalf = slot[0] < 720 === slot[1] < 720 && slot[1] !== 1440 && slot[0] !== 0;
    return clock(slot[0], !sameHalf) + " to " + clock(slot[1]);
  }

  function spans(slots) {
    var parts = slots.map(span);
    if (parts.length <= 1) return parts.join("");
    return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  }

  // The date and time in the park's time zone, wherever the reader is.
  function parkNow() {
    var forced = /[?&]now=(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)/.exec(window.location.search);
    if (forced) return { date: forced[1], minute: Number(forced[2]) * 60 + Number(forced[3]) };
    var parts = {};
    new Intl.DateTimeFormat("en-AU", {
      timeZone: data.zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date())
      .forEach(function (part) {
        parts[part.type] = part.value;
      });
    return {
      date: parts.year + "-" + parts.month + "-" + parts.day,
      minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute)
    };
  }

  // The timeline runs from data.dayStart to this minute of the day.
  function dayEnd() {
    return data.dayEnd || data.lightsOff;
  }

  function percent(minute) {
    var length = dayEnd() - data.dayStart;
    return Math.max(0, Math.min(100, ((minute - data.dayStart) / length) * 100));
  }

  // Every whole hour on the timeline.
  function hourMarks() {
    var marks = [];
    for (var hour = Math.ceil(data.dayStart / 60); hour * 60 <= dayEnd(); hour += 1) marks.push(hour);
    return marks;
  }

  // "2026-11-20" gives "2026-11-19".
  function dayBefore(date) {
    var day = new Date(date + "T00:00:00Z");
    if (isNaN(day.getTime())) return "";
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
  }

  // When the council's page was last read, which is not always when this page
  // was built: if a read fails, the time of the last good one stays.
  function checkedText(now) {
    var council = data.council || {};
    var at = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)/.exec(council.lastReadAt || "");
    if (at) {
      var time = clock(Number(at[2]) * 60 + Number(at[3]));
      if (at[1] === now.date) return "Last checked today at " + time;
      if (at[1] === dayBefore(now.date)) return "Last checked yesterday at " + time;
    }
    return council.lastReadText ? "Last checked " + council.lastReadText : "";
  }

  // ---- The answer at the top ----
  //
  // One line that says how things stand and until when. A second line only
  // where there is something the first cannot say.

  function answer(day, minute) {
    var sure = day.basis === "council";
    if (day.closed) {
      return {
        state: "closed",
        title: "Closed today",
        sub: day.label ? "Council notice: " + day.label : "The council has closed the oval."
      };
    }
    if (day.basis === "none") {
      return { state: "unknown", title: "No booking information today", sub: "Check the signs at the park." };
    }

    var current = null;
    var next = null;
    day.slots.forEach(function (slot) {
      if (slot[0] <= minute && minute < slot[1]) current = slot;
      else if (slot[0] > minute && !next) next = slot;
    });

    if (current) {
      return {
        state: "booked",
        title: (sure ? "Booked until " : "Usually booked until ") + clock(current[1]),
        rule: "Dogs must stay off the oval while an activity is on."
      };
    }
    if (!day.slots.length && day.label) {
      return { state: "unknown", title: day.label + " listed today", sub: "The oval may be closed. Check the signs at the park." };
    }
    if (next) return { state: "free", title: (sure ? "Free until " : "Probably free until ") + clock(next[0]) };
    // Today's bookings are over.
    if (day.slots.length) return { state: "free", title: sure ? "Free until tomorrow" : "Probably free until tomorrow" };
    return { state: "free", title: sure ? "Free all day" : "Probably free all day" };
  }

  // Where today's answer comes from, as a link to that source: the council's
  // page, or the part of this page that explains the usual pattern.
  function pill(day) {
    var council = String((data.council && data.council.url) || "");
    if (!/^https:\/\//.test(council)) council = "";
    if (day.closed) return { sure: "yes", text: "From a notice on the council’s page", href: council, outside: true };
    if (day.basis === "council") return { sure: "yes", text: "From the council’s schedule", href: council, outside: true };
    if (day.basis === "usual") return { sure: "no", text: "Usual pattern, not confirmed", href: "#how" };
    if (day.basis === "rough") return { sure: "no", text: "Rough guide only", href: "#how" };
    return null;
  }

  function pillHtml(day) {
    var badge = pill(day);
    if (!badge) return "";
    if (!badge.href) return '<p class="source-row"><span class="pill" data-sure="' + badge.sure + '">' + esc(badge.text) + "</span></p>";
    return (
      '<p class="source-row"><a class="pill" data-sure="' + badge.sure + '" href="' + esc(badge.href) + '"' +
      (badge.outside ? ' rel="noopener"' : "") + ">" + esc(badge.text) +
      '<span aria-hidden="true">' + NBSP + "›</span></a></p>"
    );
  }

  function heroHtml(day, now) {
    var found = answer(day, now.minute);
    return (
      '<section class="hero" data-state="' + found.state + '">' +
      '<p class="kicker">' + esc(checkedText(now) || day.name) + "</p>" +
      "<h1>" + esc(found.title) + "</h1>" +
      (found.sub ? '<p class="sub">' + esc(found.sub) + "</p>" : "") +
      (found.rule ? '<p class="rule">' + esc(found.rule) + "</p>" : "") +
      pillHtml(day) +
      (day.why ? '<p class="why">' + esc(day.why) + "</p>" : "") +
      "</section>"
    );
  }

  // ---- Today ----

  function segments(day) {
    if (day.closed) return '<span class="seg" style="left:0;width:100%"></span>';
    return day.slots
      .map(function (slot) {
        var left = percent(slot[0]);
        var width = percent(slot[1]) - left;
        return width > 0 ? '<span class="seg" style="left:' + left.toFixed(2) + "%;width:" + width.toFixed(2) + '%"></span>' : "";
      })
      .join("");
  }

  // A thin line across the bar at every hour, so a booking can be read off it.
  function hourLinesHtml() {
    return hourMarks()
      .map(function (hour) {
        var at = percent(hour * 60);
        return at > 0 && at < 100 ? '<i style="left:' + at.toFixed(2) + '%"></i>' : "";
      })
      .join("");
  }

  // A mark and a number for every hour. "am" or "pm" is written once, under
  // the first hour of each half of the day. A very long day gets a number at
  // every second mark, so the numbers still fit on a small phone.
  function ticksHtml() {
    var marks = hourMarks();
    var every = marks.length > 17 ? 2 : 1;
    var half = "";
    return marks
      .map(function (hour, index) {
        var numbered = index % every === 0;
        var mine = hour % 24 < 12 ? "am" : "pm";
        var html = '<span style="left:' + percent(hour * 60).toFixed(2) + '%">';
        if (numbered) {
          html += (hour % 12 || 12) + (mine !== half ? "<small>" + mine + "</small>" : "");
          half = mine;
        }
        return html + "</span>";
      })
      .join("");
  }

  function timesHtml(day) {
    if (day.closed) return '<li><span class="key booked"></span>Closed all day</li>';
    if (day.basis === "none") return "<li>No booking information</li>";
    var usual = day.basis !== "council";
    if (!day.slots.length) {
      if (day.label) return "<li>" + esc(day.label) + " listed</li>";
      return '<li><span class="key"></span>' + (usual ? "Usually no bookings" : "No bookings") + "</li>";
    }
    return (
      '<li><span class="key booked"></span>' +
      (usual ? "Usually booked " : "Booked ") +
      esc(spans(day.slots)) +
      (day.label ? " (" + esc(day.label) + ")" : "") +
      "</li>"
    );
  }

  function outlook(hours, minute) {
    var nowHour = Math.floor(minute / 60);
    var ahead = (hours || []).filter(function (hour) {
      return hour[0] >= nowHour && hour[0] <= LAST_RAIN_HOUR && hour[1] !== null;
    });
    if (!ahead.length) return { level: "unknown", text: "No rain forecast available." };

    var peak = ahead[0];
    var mm = 0;
    ahead.forEach(function (hour) {
      if (hour[1] > peak[1]) peak = hour;
      mm += hour[2] || 0;
    });
    var amount = mm < 0.05 ? "" : mm < 0.75 ? "under 1" + NBSP + "mm" : "about " + Math.round(mm) + NBSP + "mm";

    if (peak[1] < SLIGHT) return { level: "dry", text: "No rain expected for the rest of today." };
    if (peak[1] < LIKELY) {
      return { level: "slight", text: "Slight chance of rain (" + peak[1] + "% around " + clock(peak[0] * 60) + ")." };
    }

    var runs = [];
    ahead.forEach(function (hour) {
      if (hour[1] < LIKELY) return;
      var last = runs[runs.length - 1];
      if (last && last[last.length - 1] === hour[0] - 1) last.push(hour[0]);
      else runs.push([hour[0]]);
    });
    var first = runs[0][0];
    var last = runs[0][runs[0].length - 1];
    var startsNow = first <= nowHour;
    var runsOut = last >= ahead[ahead.length - 1][0];
    var when;
    if (startsNow && runsOut) when = "for the rest of today";
    else if (startsNow) when = "until about " + clock((last + 1) * 60);
    else if (runsOut) when = "from about " + clock(first * 60);
    else when = "between " + clock(first * 60) + " and " + clock((last + 1) * 60);
    var text = "Rain likely " + when + " (up to " + peak[1] + "%" + (amount ? ", " + amount : "") + ").";
    if (runs.length > 1) text += " More from about " + clock(runs[1][0] * 60) + ".";
    return { level: "likely", text: text };
  }

  // Millimetres for a label on the chart: "4.6", "0.2", "12".
  function mmText(mm) {
    return mm >= 9.95 ? String(Math.round(mm)) : mm.toFixed(1);
  }

  function rainHtml(day, minute, live) {
    if (!day.hours) {
      var total = day.rain ? day.rain.mm : null;
      if (total === null || total === undefined) return "";
      var words = total < 0.05 ? "No rain expected today." : "Rain today: " + (total < 0.75 ? "under 1" : "about " + Math.round(total)) + NBSP + "mm.";
      return '<div class="rain"><p class="rain-text">' + esc(words) + "</p></div>";
    }
    var look = live ? outlook(day.hours, minute) : null;
    var nowHour = Math.floor(minute / 60);
    // The hours on the timeline, so that the bars sit under the same hour marks.
    var hours = day.hours.filter(function (hour) {
      return (hour[0] + 1) * 60 > data.dayStart && hour[0] * 60 < dayEnd();
    });
    var most = null;
    hours.forEach(function (hour) {
      if (hour[2] >= 0.05 && (!most || hour[2] > most[2])) most = hour;
    });

    var chart = "";
    if (most) {
      var full = Math.max(RAIN_FULL_MM, most[2]);
      var bars = hours
        .map(function (hour) {
          var mm = hour[2] || 0;
          if (mm < 0.05) return "";
          var left = percent(hour[0] * 60);
          var width = percent((hour[0] + 1) * 60) - left;
          var title = clock(hour[0] * 60) + ": " + mmText(mm) + " mm" + (hour[1] === null ? "" : ", " + hour[1] + "% chance");
          return (
            '<span style="left:' + left.toFixed(2) + "%;width:" + width.toFixed(2) + "%;height:" + Math.max(5, (mm / full) * 100).toFixed(1) + '%"' +
            ' title="' + esc(title) + '"' + (live && hour[0] < nowHour ? ' data-past="yes"' : "") + ">" +
            "<b>" + mmText(mm) + "</b></span>"
          );
        })
        .join("");
      var label = "Rain for each hour in millimetres. Most: " + mmText(most[2]) + " mm at " + clock(most[0] * 60) + ".";
      chart =
        '<div class="rain-chart" role="img" aria-label="' + esc(label) + '"><div class="rain-plot">' + bars + "</div></div>" +
        '<div class="ticks" aria-hidden="true">' + ticksHtml() + "</div>";
    }
    var caption = [];
    if (most) caption.push("Rain each hour, in millimetres.");
    if (data.rainFrom) caption.push("Forecast from " + data.rainFrom + ".");
    return (
      '<div class="rain">' +
      (look ? '<p class="rain-text">' + esc(look.text) + "</p>" : "") +
      chart +
      (caption.length ? '<p class="rain-caption">' + esc(caption.join(" ")) + "</p>" : "") +
      "</div>"
    );
  }

  function todayHtml(day, now) {
    var sure = day.basis === "council" ? "yes" : "no";
    var known = day.basis === "none" ? "no" : "yes";
    var inDay = now.minute >= data.dayStart && now.minute <= dayEnd();
    return (
      '<section class="card">' +
      "<h2>Today <span>" + esc(day.name) + "</span></h2>" +
      '<div class="timeline">' +
      '<div class="bar-wrap"><div class="bar" data-sure="' + sure + '" data-known="' + known + '">' + segments(day) + hourLinesHtml() + "</div>" +
      (inDay ? '<span class="now-line" style="left:' + percent(now.minute).toFixed(2) + '%" title="Now"></span>' : "") +
      "</div>" +
      '<div class="ticks" aria-hidden="true">' + ticksHtml() + "</div>" +
      "</div>" +
      '<ul class="times">' + timesHtml(day) + "</ul>" +
      rainHtml(day, now.minute, true) +
      "</section>"
    );
  }

  // ---- The week ahead ----

  function dayText(day) {
    if (day.closed) return "Closed";
    if (day.basis === "none") return "No information";
    var text = day.slots.length ? spans(day.slots) : day.label ? day.label : "No bookings";
    if (day.slots.length && day.label) text += " (" + day.label + ")";
    return text;
  }

  function weekHtml(days) {
    if (!days.length) return "";
    var isUsual = function (day) {
      return day.basis === "usual" || day.basis === "rough";
    };
    var anyUsual = days.some(isUsual);
    // When the whole week is the usual pattern, say so once instead of on every row.
    var allUsual = days.every(function (day) {
      return isUsual(day) || day.basis === "none";
    }) && anyUsual;
    var rows = days
      .map(function (day) {
        var usual = isUsual(day) && !allUsual;
        // The day's rain in millimetres. Under a twentieth of one counts as dry.
        var mm = day.rain && typeof day.rain.mm === "number" ? day.rain.mm : null;
        var wet = mm !== null && mm >= 0.05;
        var rain = mm === null ? "" : wet ? "<strong>" + (mm < 0.75 ? "&lt;1" : Math.round(mm)) + NBSP + "mm</strong><small>rain</small>" : "Dry";
        var parts = day.name.split(" ");
        return (
          '<li class="day">' +
          '<div class="day-name">' + esc(parts[0]) + "<small>" + esc(parts.slice(1).join(" ")) + "</small></div>" +
          '<div class="day-main"><div class="day-text">' + esc(dayText(day)) + (usual ? ' <span class="tag">usual</span>' : "") + "</div>" +
          '<div class="mini" data-known="' + (day.basis === "none" ? "no" : "yes") + '">' + segments(day) + "</div></div>" +
          '<div class="day-rain" data-dry="' + (wet ? "no" : "yes") + '">' + rain + "</div>" +
          "</li>"
        );
      })
      .join("");
    return (
      '<section class="card">' +
      "<h2>The week ahead " + (allUsual ? '<span class="tag">usual pattern</span>' : "<span>booked times</span>") + "</h2>" +
      '<ol class="days">' + rows + "</ol>" +
      '<p class="legend"><span class="key"></span>Free<span class="key booked"></span>Booked</p>' +
      (allUsual
        ? '<p class="legend-note">These are the usual times, not yet confirmed by the council.</p>'
        : anyUsual
          ? '<p class="legend-note"><span class="tag">usual</span> means the usual pattern, not yet confirmed by the council.</p>'
          : "") +
      "</section>"
    );
  }

  // ---- Putting it together ----

  function staleHtml() {
    var built = Date.parse(data.generated);
    if (isNaN(built) || Date.now() - built < 26 * 3600 * 1000) return "";
    return '<p class="stale">This page has not updated since ' + esc(data.generatedText) + ". The times may be out of date.</p>";
  }

  function render() {
    var now = parkNow();
    var index = -1;
    data.days.forEach(function (day, i) {
      if (day.date === now.date) index = i;
    });
    var html = staleHtml();
    if (index === -1) {
      html +=
        '<section class="hero" data-state="unknown"><p class="kicker">' + esc(checkedText(now) || clock(now.minute)) + "</p>" +
        "<h1>No information for today</h1>" +
        '<p class="sub">This page is out of date. Check the signs at the park or the council’s page.</p></section>';
      html += weekHtml(data.days.filter(function (day) { return day.date > now.date; }));
    } else {
      html += heroHtml(data.days[index], now) + todayHtml(data.days[index], now) + weekHtml(data.days.slice(index + 1, index + 8));
    }
    if (html !== shown) {
      app.innerHTML = html;
      shown = html;
    }
  }

  function refresh() {
    lastFetch = Date.now();
    if (!window.fetch) return;
    fetch("data.json?t=" + lastFetch, { cache: "no-store" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (fresh) {
        // Only ever move forward: a stale copy from a cache must not replace newer data.
        if (fresh && fresh.days && Date.parse(fresh.generated) > Date.parse(data.generated)) {
          data = fresh;
          render();
        }
      })
      .catch(function () {});
  }

  render();
  setInterval(render, 30 * 1000);
  setInterval(refresh, 15 * 60 * 1000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) return;
    render();
    if (Date.now() - lastFetch > 5 * 60 * 1000) refresh();
  });

  // ---- Links and buttons ----

  // The "usual pattern" badge leads to "How this works", which is folded shut.
  app.addEventListener("click", function (event) {
    var target = event.target;
    var link = target && target.closest ? target.closest('a[href="#how"]') : null;
    var how = document.getElementById("how");
    if (link && how) how.open = true;
  });

  var copy = document.getElementById("copy");
  if (copy) {
    var copyLabel = copy.textContent;
    var copyTimer = null;
    copy.addEventListener("click", function () {
      var address = data.site || window.location.href;
      var copied = function () {
        copy.textContent = "Link copied";
        clearTimeout(copyTimer);
        copyTimer = setTimeout(function () {
          copy.textContent = copyLabel;
        }, 2500);
      };
      // If the link cannot be copied from here, show it so it can be copied by hand.
      var byHand = function () {
        var line = document.getElementById("address");
        if (line) line.hidden = false;
      };
      var share = function () {
        if (!navigator.share) return byHand();
        navigator.share({ title: document.title, text: "Is the oval free for dogs right now?", url: address }).catch(byHand);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(address).then(copied, share);
      } else {
        share();
      }
    });
  }

  // ---- The daily alert as a notification on this device ----
  //
  // The browser gives this device an address for notifications. That address
  // is handed to the backend named in the page's data, which sends the alert
  // once a day. The script beside this page, sw.js, shows it when it arrives.
  // The backend learns nothing else about the device or the person.

  var notify = document.getElementById("notify");
  var notifyNote = document.getElementById("notify-note");
  var backend = /^https:\/\/\S+$/.test(data.push || "") ? String(data.push).replace(/\/+$/, "") : "";

  if (notify && notifyNote && backend) {
    (function () {
      var agent = navigator.userAgent || "";
      var apple = /iPad|iPhone|iPod/.test(agent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      var saved = navigator.standalone === true || !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
      var able = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      // An iPhone or iPad allows notifications only for a page saved to its Home Screen.
      var needsHome = !able && apple && !saved;
      if (!able && !needsHome) return; // nothing to offer in this browser

      var device = /iPhone|iPod|Android.*Mobile/.test(agent) ? "phone" : "device";
      var alertAt = clock(Math.floor(((data.alert && data.alert.from) || 870) / 60 + 0.5) * 60);
      var DAY = 24 * 3600 * 1000;
      var on = false;
      var busy = false;

      var words = {
        home:
          "On an iPhone or iPad, alerts only work from the Home Screen. Open this page in Safari, tap the Share button, " +
          "choose “Add to Home Screen”, then open it from there and tap this button again.",
        blocked: "Notifications are blocked for this page. Allow them in your browser’s settings for this site, then tap the button again.",
        dismissed: "",
        on: "Alerts are on for this " + device + ": one a day, at about " + alertAt + ". A first notification is on its way, to show that it works.",
        off: "Alerts are off for this " + device + ".",
        full: "No more devices can be added at the moment. Please try again another day.",
        // The browser itself said no. A private window is the usual reason, and a page cannot tell that it is in one.
        refused:
          "This browser could not set up notifications. If this is a private or incognito window, open the page in a normal one and try again.",
        browser: "This browser could not set up notifications. Please try again later.",
        service: "The alerts service could not be reached. Check your connection and try again in a minute."
      };

      function say(text) {
        notifyNote.textContent = text;
        notifyNote.hidden = !text;
      }

      function show(isOn) {
        on = isOn;
        notify.textContent = (isOn ? "Turn off alerts on this " : "Get alerts on this ") + device;
        // Only the offer is the filled button. Turning alerts off should not be the loudest thing on the page.
        if (notify.classList) notify.classList.toggle("primary", !isOn);
      }

      function setBusy(isBusy) {
        busy = isBusy;
        notify.disabled = isBusy;
      }

      // A failure with one of the reasons above, so the right words can be shown.
      function failure(reason) {
        var error = new Error(reason);
        error.reason = reason;
        return error;
      }

      // The backend's public key, as the bytes a browser wants.
      function keyBytes(text) {
        var padded = (text + "===".slice((text.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
        var raw = window.atob(padded);
        var bytes = new Uint8Array(raw.length);
        for (var index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
        return bytes;
      }

      // Ask the backend. The answer always comes back as an object with "status".
      function ask(path, body) {
        var options = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
        return fetch(backend + path, options).then(
          function (response) {
            return response.json().then(
              function (reply) {
                reply = reply && typeof reply === "object" ? reply : {};
                reply.status = response.status;
                return reply;
              },
              function () {
                return { ok: false, status: response.status };
              }
            );
          },
          function () {
            throw failure("service");
          }
        );
      }

      function permission() {
        return new Promise(function (resolve) {
          var asked;
          try {
            asked = Notification.requestPermission(resolve);
          } catch (error) {
            resolve("denied");
            return;
          }
          if (asked && asked.then) {
            asked.then(resolve, function () {
              resolve("default");
            });
          }
        });
      }

      function subscription() {
        return navigator.serviceWorker.getRegistration().then(function (registration) {
          return registration ? registration.pushManager.getSubscription() : null;
        });
      }

      // Get this device an address for notifications and hand it to the backend.
      // An address the backend calls "gone" is dropped, and a new one is tried once.
      function join(again) {
        return navigator.serviceWorker
          .register("sw.js")
          .then(
            function () {
              return navigator.serviceWorker.ready;
            },
            function () {
              throw failure("refused");
            }
          )
          .then(function (registration) {
            return registration.pushManager.getSubscription().then(function (existing) {
              if (existing) return existing;
              return ask("/key").then(function (reply) {
                if (!reply.key) throw failure("service");
                return registration.pushManager
                  .subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(String(reply.key)) })
                  .catch(function () {
                    throw failure(Notification.permission === "denied" ? "blocked" : "refused");
                  });
              });
            });
          })
          .then(function (mine) {
            return ask("/subscribe", { subscription: mine.toJSON() }).then(
              function (reply) {
                if (reply.ok) return reply;
                // "gone": the address does not work. "host": a notification service the backend does not know.
                var reason = reply.reason === "full" ? "full" : reply.reason === "gone" || reply.reason === "host" ? "browser" : "service";
                return mine.unsubscribe().then(function () {
                  if (reply.reason === "gone" && again !== false) return join(false);
                  throw failure(reason);
                });
              },
              function (error) {
                // Not handed over, so not kept: the button must tell the truth.
                return mine.unsubscribe().then(function () {
                  throw error;
                });
              }
            );
          });
      }

      function turnOn() {
        if (Notification.permission === "denied") return say(words.blocked);
        setBusy(true);
        say("");
        // Asked first, while this is still the tap: some browsers only ask during one.
        permission()
          .then(function (answer) {
            if (answer !== "granted") throw failure(answer === "denied" ? "blocked" : "dismissed");
            return join();
          })
          .then(
            function () {
              show(true);
              say(words.on);
            },
            function (error) {
              show(false);
              say(words[error && error.reason] === undefined ? words.browser : words[error.reason]);
            }
          )
          .then(function () {
            setBusy(false);
          });
      }

      function turnOff() {
        setBusy(true);
        say("");
        subscription()
          .then(function (mine) {
            if (!mine) return null;
            var endpoint = mine.endpoint;
            return mine.unsubscribe().then(function () {
              // If this message is lost, the backend finds out by itself the next time it sends.
              return ask("/unsubscribe", { endpoint: endpoint }).catch(function () {});
            });
          })
          .then(
            function () {
              show(false);
              say(words.off);
            },
            function () {
              say(words.browser);
            }
          )
          .then(function () {
            setBusy(false);
          });
      }

      // Once a day at most, a device with alerts on checks that the backend still
      // has its address. If the address has stopped working, it quietly gets a new one.
      function checkIn(mine) {
        try {
          if (Date.now() - Number(window.localStorage.getItem("alertCheck") || 0) < DAY) return;
          window.localStorage.setItem("alertCheck", String(Date.now()));
        } catch (error) {
          return; // nowhere to remember the last check, so do not ask on every visit
        }
        ask("/subscribe", { subscription: mine.toJSON() })
          .then(function (reply) {
            if (reply.ok || reply.reason !== "gone") return null;
            return mine.unsubscribe().then(function () {
              if (Notification.permission !== "granted") return show(false);
              return join(false).then(
                function () {
                  show(true);
                },
                function () {
                  show(false);
                }
              );
            });
          })
          .catch(function () {});
      }

      show(false);
      notify.hidden = false;
      notify.addEventListener("click", function () {
        if (busy) return;
        if (needsHome) return say(words.home);
        if (on) turnOff();
        else turnOn();
      });
      if (able) {
        subscription()
          .then(function (mine) {
            if (!mine) return;
            show(true);
            checkIn(mine);
          })
          .catch(function () {});
      }
    })();
  }
})();
