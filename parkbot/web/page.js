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
  function source(day) {
    var council = String((data.council && data.council.url) || "");
    if (!/^https:\/\//.test(council)) council = "";
    if (day.closed) return { sure: "yes", text: "From a notice on the council’s page", href: council, outside: true };
    if (day.basis === "council") return { sure: "yes", text: "From the council’s schedule", href: council, outside: true };
    if (day.basis === "usual") return { sure: "no", text: "Usual pattern, not confirmed", href: "#how" };
    if (day.basis === "rough") return { sure: "no", text: "Rough guide only", href: "#how" };
    return null;
  }

  // One quiet line under the answer. It is a link only when there is somewhere to lead.
  function sourceHtml(day) {
    var from = source(day);
    if (!from) return "";
    var words = esc(from.text);
    if (from.href) words = '<a href="' + esc(from.href) + '"' + (from.outside ? ' rel="noopener"' : "") + ">" + words + "</a>";
    return '<p class="source-row" data-sure="' + from.sure + '">' + words + "</p>";
  }

  // In a picture (see "A picture of the day" below) nothing can be pressed and
  // the reader knows the rule, so the source is named only when it is a
  // warning, in plain words.
  function heroHtml(day, now, picture) {
    var found = answer(day, now.minute);
    var from = source(day);
    return (
      '<section class="hero" data-state="' + found.state + '">' +
      '<p class="kicker">' + esc(checkedText(now) || day.name) + "</p>" +
      "<h1>" + esc(found.title) + "</h1>" +
      (found.sub ? '<p class="sub">' + esc(found.sub) + "</p>" : "") +
      (picture
        ? (from && from.sure === "no" ? '<p class="source-row" data-sure="no">' + esc(from.text) + "</p>" : "")
        : (found.rule ? '<p class="rule">' + esc(found.rule) + "</p>" : "") +
          sourceHtml(day) +
          (day.why ? '<p class="why">' + esc(day.why) + "</p>" : "")) +
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

  // The rain: a sentence, then the millimetres for each hour. In a picture
  // ("live" false) only the chart, as the alert says the rest in words, and
  // nothing at all for a dry day. A minute of -1 is a day still to come.
  function rainHtml(day, minute, live) {
    if (!day.hours) {
      if (!live) return "";
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
            ' title="' + esc(title) + '"' + (hour[0] < nowHour ? ' data-past="yes"' : "") + ">" +
            "<b>" + mmText(mm) + "</b></span>"
          );
        })
        .join("");
      var label = "Rain for each hour in millimetres. Most: " + mmText(most[2]) + " mm at " + clock(most[0] * 60) + ".";
      chart =
        '<div class="rain-chart" role="img" aria-label="' + esc(label) + '"><div class="rain-plot">' + bars + "</div></div>" +
        '<div class="ticks" aria-hidden="true">' + ticksHtml() + "</div>";
    }
    if (!live && !most) return "";
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

  // Today's timeline, with a line at "now". Without "now" it is a day still to
  // come, drawn whole for a picture: no line, and no hour of rain that has passed.
  function todayHtml(day, now, picture) {
    var sure = day.basis === "council" ? "yes" : "no";
    var known = day.basis === "none" ? "no" : "yes";
    var inDay = now && now.minute >= data.dayStart && now.minute <= dayEnd();
    return (
      '<section class="card">' +
      "<h2>" + (now ? "Today" : "Tomorrow") + " <span>" + esc(day.name) + "</span></h2>" +
      '<div class="timeline">' +
      '<div class="bar-wrap"><div class="bar" data-sure="' + sure + '" data-known="' + known + '">' + segments(day) + hourLinesHtml() + "</div>" +
      (inDay ? '<span class="now-line" style="left:' + percent(now.minute).toFixed(2) + '%" title="Now"></span>' : "") +
      "</div>" +
      '<div class="ticks" aria-hidden="true">' + ticksHtml() + "</div>" +
      "</div>" +
      '<ul class="times">' + timesHtml(day) + "</ul>" +
      rainHtml(day, now ? now.minute : -1, !picture) +
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

  // ---- A picture of the day, for the chat bot's alerts ----
  //
  // With "card=" and a date in the address, the script draws only the answer
  // and that day's timeline, for the daily check to photograph (picture.py):
  // the bot sends the picture with its alert. "now=" is the time the alert is
  // written for. A date after it is the next day, for an alert sent the
  // evening before: that picture is the day's timeline alone, as there is no
  // "now" in it for the answer at the top to speak of.

  function cardDate() {
    var found = /[?&]card=(\d{4}-\d\d-\d\d)/.exec(window.location.search);
    return found ? found[1] : "";
  }

  function cardHtml(date, now) {
    var day = null;
    data.days.forEach(function (one) {
      if (one.date === date) day = one;
    });
    if (!day) return "";
    if (date === now.date) return heroHtml(day, now, true) + todayHtml(day, now, true);
    return dayBefore(date) === now.date ? todayHtml(day, null, true) : "";
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
    var card = cardDate();
    var html = card ? cardHtml(card, now) : staleHtml();
    if (card) {
      // Only the picture is drawn.
    } else if (index === -1) {
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

  // The "usual pattern" link leads to "How this works", which is folded shut.
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

  // ---- Leftovers of the notifications this page once offered ----
  //
  // Until 23 November 2026 the page could send the daily alert as a
  // notification, through a small script it left in the browser (sw.js). The
  // alert now comes only from the bot. A browser that still has that script is
  // asked to forget it, with its address for notifications and the note of
  // when it last checked in.

  if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
    navigator.serviceWorker
      .getRegistrations()
      .then(function (registrations) {
        registrations.forEach(function (registration) {
          var push = registration.pushManager;
          (push ? push.getSubscription() : Promise.resolve(null))
            .then(function (mine) {
              return mine ? mine.unsubscribe() : null;
            })
            .catch(function () {})
            .then(function () {
              return registration.unregister();
            })
            .catch(function () {});
        });
      })
      .catch(function () {});
  }
  try {
    window.localStorage.removeItem("alertCheck");
  } catch (error) {
    // nothing was kept here
  }

  // ---- Counting visits and presses, for the stats page ----
  //
  // The backend counts how many times the page is opened, from how many
  // different devices, how often those devices come back, how they found the
  // page, how long they stay, and which buttons and links are pressed. What is
  // sent is what happened, such as "a visit, this device's 3rd, 2 days after
  // its last one", with a random number this device makes up for itself, so
  // that its visits can be told apart from others'. No cookie, and nothing
  // about the person. This device remembers, in its own storage, only that
  // number, the date of its last visit and how many visits it has made.

  // The backend named in the page's data, which keeps the counts.
  var backend = /^https:\/\/\S+$/.test(data.backend || "") ? String(data.backend).replace(/\/+$/, "") : "";
  // Only the real page counts, not a copy of it opened somewhere else, and not a program steering a browser.
  var counting = !!backend && !navigator.webdriver && (function () {
    try {
      return new URL(data.site).origin === window.location.origin;
    } catch (error) {
      return false;
    }
  })();

  function remembered(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function remember(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch (error) {
      // nowhere to remember it
    }
  }

  // Two markers in the address. "?qr" is in the address the QR code holds, so
  // a visit through the code can be told apart. "?me" marks this browser as
  // the owner's, so that its visits are counted apart ("?me=off" undoes it).
  // Both are taken out of the address again, so that a copied link carries neither.
  var cameBy = "";
  var mine = remembered("statsMine") === "1";
  (function () {
    var search = window.location.search || "";
    if (!/[?&](qr|me)(=[^&]*)?(&|$)/.test(search)) return;
    var kept = [];
    search
      .replace(/^\?/, "")
      .split("&")
      .forEach(function (part) {
        var name = part.split("=")[0];
        var value = part.slice(name.length + 1);
        if (name === "qr") cameBy = "qr";
        else if (name === "me") {
          mine = value !== "off";
          remember("statsMine", mine ? "1" : null);
        } else if (part) kept.push(part);
      });
    try {
      window.history.replaceState(null, "", window.location.pathname + (kept.length ? "?" + kept.join("&") : "") + (window.location.hash || ""));
    } catch (error) {
      // the address stays as it is
    }
  })();
  if (!cameBy) {
    try {
      cameBy = document.referrer ? new URL(document.referrer).hostname : "";
    } catch (error) {
      cameBy = "";
    }
  }

  // This device's random number: 16 hexadecimal digits, made once and kept.
  // Empty if nothing can be kept here, so that a browser that forgets does
  // not look like a new visitor on every visit.
  var deviceId = remembered("deviceId") || "";
  if (counting && !/^[0-9a-f]{16}$/.test(deviceId)) {
    var digits = "";
    try {
      var bytes = new Uint8Array(8);
      window.crypto.getRandomValues(bytes);
      for (var byte = 0; byte < bytes.length; byte += 1) digits += (bytes[byte] < 16 ? "0" : "") + bytes[byte].toString(16);
    } catch (error) {
      for (var place = 0; place < 16; place += 1) digits += Math.floor(Math.random() * 16).toString(16);
    }
    remember("deviceId", digits);
    deviceId = remembered("deviceId") === digits ? digits : "";
  }

  function send(what) {
    if (!counting) return;
    if (deviceId) what.id = deviceId;
    var text = JSON.stringify(what);
    // A beacon still goes out when the press takes the reader to another page.
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(backend + "/hit", text)) return;
    } catch (error) {
      // try the other way
    }
    try {
      fetch(backend + "/hit", { method: "POST", body: text, keepalive: true, mode: "no-cors", credentials: "omit" }).catch(function () {});
    } catch (error) {
      // not counted, which is fine
    }
  }

  // The owner's own browsers send only their visits, marked as theirs.
  function count(name) {
    if (!mine) send({ kind: "press", name: name });
  }

  function daysBetween(earlier, later) {
    var from = Date.UTC(Number(earlier.slice(0, 4)), Number(earlier.slice(5, 7)) - 1, Number(earlier.slice(8, 10)));
    var to = Date.UTC(Number(later.slice(0, 4)), Number(later.slice(5, 7)) - 1, Number(later.slice(8, 10)));
    var days = Math.round((to - from) / 86400000);
    return days >= 0 && days <= 36500 ? days : null;
  }

  // `again` is true for a look at a tab that was left open.
  function countVisit(again) {
    var today = parkNow().date;
    var last = remembered("lastVisit");
    if (last && !/^\d{4}-\d\d-\d\d$/.test(last)) last = null;
    var nth = Math.min(1000000, (parseInt(remembered("visits"), 10) || 0) + 1);
    remember("lastVisit", today);
    remember("visits", String(nth));
    // If nothing could be remembered, this device counts as new, and says nothing about earlier visits.
    var stored = remembered("lastVisit") === today;
    send({
      kind: "visit",
      newToday: last !== today,
      newThisMonth: !last || last.slice(0, 7) !== today.slice(0, 7),
      firstEver: !last,
      since: last ? daysBetween(last, today) : null,
      nth: stored ? nth : null,
      source: again ? "" : cameBy,
      again: !!again,
      touch: (navigator.maxTouchPoints || 0) > 0,
      mine: mine
    });
  }

  // How long each look at the page lasted, sent as the page goes out of sight.
  var shownAt = Date.now();
  function countStay() {
    if (!shownAt || mine) return;
    send({ kind: "stay", seconds: Math.round((Date.now() - shownAt) / 1000) });
    shownAt = 0;
  }

  // The part of the page a button or link is in, and what it is: "buttons:t.me", "share:copy", "how:open".
  var AREAS = [["nav.actions", "buttons"], ["#app", "status"], [".about", "about"], ["#share", "share"], ["#how", "how"], ["footer", "footer"]];

  function pressName(target) {
    var area = "page";
    for (var index = 0; index < AREAS.length; index += 1) {
      if (target.closest(AREAS[index][0])) {
        area = AREAS[index][1];
        break;
      }
    }
    var what = target.getAttribute("data-stat") || "";
    if (!what && target.tagName === "SUMMARY") what = "open";
    if (!what) what = target.id || "";
    if (!what && target.tagName === "A") {
      var href = target.getAttribute("href") || "";
      if (href.charAt(0) === "#") what = "to-" + href.slice(1);
      else if (/^mailto/i.test(href)) what = "email"; // an email link
      else what = String(target.hostname || "").replace(/^www\./, "");
    }
    what = String(what || target.tagName || "")
      .toLowerCase()
      .replace(/[^a-z0-9.:_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "");
    return what ? (area + ":" + what).slice(0, 64) : "";
  }

  if (counting && document.addEventListener) {
    countVisit(false);
    // Looking at the page again after half an hour away counts as another visit.
    var hiddenAt = 0;
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        hiddenAt = Date.now();
        countStay();
      } else {
        if (hiddenAt && Date.now() - hiddenAt >= 30 * 60 * 1000) countVisit(true);
        shownAt = Date.now();
      }
    });
    if (window.addEventListener) window.addEventListener("pagehide", countStay);
    // Caught on the way down, before anything else sees the press.
    document.addEventListener(
      "click",
      function (event) {
        var target = event.target && event.target.closest ? event.target.closest("a[href], button, summary") : null;
        if (!target) return;
        // A fold counts when it is opened, not when it is closed.
        if (target.tagName === "SUMMARY" && target.parentNode && target.parentNode.open) return;
        var name = pressName(target);
        if (name) count(name);
      },
      true
    );
  }
})();
