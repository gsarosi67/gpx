#!/usr/bin/env node

var parser = require('fast-xml-parser');
var polyline = require( 'google-polyline' );
const { registerFont, createCanvas } = require("canvas");
var util = require('util');
const fetch = require('node-fetch');
var fs = require('fs');
var readFileAsync = util.promisify(fs.readFile);

const GOOGLE_MAPS_API_KEY = require('./api_key.js');

const format_types = ["jpg","jpeg-baseline","png","png8","png32","gif"];

var options = {
    inputFilename: "default.gpx",
    duration: 300,
    bearingDelta: 2,
    encode: false,
    pathColor: "0xFF0000FF",
    pathWeight: 4,
    mapzoom: 14,
    mapwidth: 480,
    mapheight: 270,
    mapurl: "maps.googleapis.com",
    mapurlpath: "/maps/api/staticmap",
    mapprotocol: "https",
    mapapikey: GOOGLE_MAPS_API_KEY,
    marker: true,
    markerColor: "green",
    markerSize: "tiny",
    mapCenter: true,
    outputPath: "./",
    dataoutputPath: "./",
    outputFilebase: "bikemap",
    dataoutputFilebase: "bikedata",
    outputExt: "png",
    dataoutputExt: "png",
    bCreateimage: true,
    bCreatedataimage: true,
    timezone: "America/New_York",
    dateFont: "16px sans-serif",
    headerFont: "18px sans-serif",
    speeddistFont: "46px sans-serif",
    dataFont: "18px sans-serif",
    timeSpacing: 5,
    dataSpacing: 10,
    headerSpacing: 15,
    backgroundColor: "#282c34",
    textColor: "#16f056",
    alpha: 1.0,
    strokeWidth: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    infoview_width: 480,
    infoview_height: 270,
    strokeWidth: 0,
    strokeColor: "white",
    dataTopmargin: 30,
    speedHeader: "speed",
    distanceHeader: "distance",
    speedLabel: "mph",
    distanceLabel: "miles",
    avgSpeedlabel: "avg:",
    topSpeedlabel: "top:",
    distStartlabel: "distance to start:",
    elevationLabel: "elevation:",
    elevationUnits: "ft",
    elapsedTimelabel: "elapsed time:",
    dataPadding: 5,
    bVerbose: false,
    bVerboseData: false

};


const MPH_CONVERSION_FACTOR = 0.681818;
const FEETMILES = 5280;
const POLYLINE_FACTOR = 100000;
const FEET_PER_METERS =  3.2808;


String.prototype.padFunction = function(padStr, len) {
   var str = this;
   while (str.length < len)
      str = padStr + str;
   return str;
}


init();

function init() {
    var gpxData;

    processCommandline(process.argv, options);

    console.log("******** Process gpx file ***********");
    console.log(" GPX filename: " + options.inputFilename);
    console.log(" duration: " + options.duration);
    console.log(" create map image: " + options.bCreateimage);
    console.log(" create data image: " + options.bCreatedataimage);

    loadData().then(function(result) {

      /*
          Now I have the data, what do I do with it???

               1. Determine the sample rate we want to use.  This is will be an input value. It is the duration
                  of the main trip video.  if the video is 6 minutes long this is 360 seconds.  If we assume one overlay image
                  per seccond we need 360 images or "trkpt".  But we should have a lot more than that if we have data for the entire trip
                  in real time.  So we need to determine our "scale" factor.  if we need 360 points but the we have a hour hour, i.e. 3600 points
                  our scale factor is 1/10.  We just need to create an overlay image using every 10th data point
               2. Call google maps using the lat/lon and get an image file for each point.
		              - looks like the google maps static image api cost $2.00 per 1000 requests.
                      - But the first $200 of usage each month is free
                      -  A 6 minute video is 360 seconds, i.e. 360 maps api calls
                      -  If I did 5 per week, that would be 1800 api calls per week, rounding up $4 per week
                      -  To hit the limit of $200 per month, is $50 per week or 25,000 requests per week
                      -  Another option is ArcGIS - 1M transactions per month for free
                  - using the google maps static api, I can use the path parameter to draw a path of the trip.
                      - this could get very long with 300 - 500 points.
                      - will need to use the encoded polyline format: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
                      - this will reduce each lat/lon pair to 9 chars each
                      - with 350 - 500 points this still will be very long
                      - probably need an option to reduce the number of points
                        - is there some way to determine the minimum number of points needed?  For straight paths less points are required.
                          really just need the points when the path turns, how can this be detected?
                        - will try using the bearing calculation below.
                            - when adding a point to the path, only add it if it is the last point (i.e. farthest traveled) or
                              if the bearing delta is more than **some value to be determined**
                            - what is the bearing delta?  I guess the difference in bearing between 3 points a to b and then b to c.
               3. Create a graph of elevation.
               4. Use the lat/lon and time to get a speed, will this work?  Top speed?
               5. Use the lat/lon to calculate total distance traveled.  Could we also calculate distance from start?
               6. What is the right way to render this into images that can be made into a movie?  Should each dashboard element be
                  a seperate movie that can be composed into a final movie or should we render one overlay with a transparent background?
                    - I am thinking each element seperate.
       */

        gpxData = result;
        if (gpxData != undefined) {
            var interval;
            var trip = gpxData.gpx.trk.trkseg.trkpt;

            if (trip.length < options.duration) {
                /* Don't have enough data points, assuming one point per second.
                   What if the data samples cover the entire trip but are every 2 secs, or 5 secs?
                   should probably add a parameter for the data sample interval for now assume 1 per second */
                console.log("[init]: Error: data sample length (" + trip.length + ") is less than duration " + options.duration + ")");
                process.exit(-1);
            }

            /* Calculate the data sample interval */
            interval = trip.length / options.duration;
            console.log(" Trip length: " + trip.length + " calculated interval: " + interval);

            var index1 = 0;
            var index1r = 0.0;
            var i = 0;
            var totalDistance = 0;
            var speed_total = 0;
            var speed_max = 0;
            var speed_avg = 0;
            var toStart;
            var currentBearing = 0;
            var pathArray = [];
            var pathIndex = 0;
            var canvas;

            /* need to create 1 frame per second with duration as the total number of seconds
                  - first frame will not have a distance or path!

            */
            /* Create the first frame.  It will not have a path since this is the start of the trip, just a marker and
               center point */
            if (options.bCreateimage) {
               var urlString = createMapurl(trip[0].lat,trip[0].lon);
               var filePath = options.outputPath + options.outputFilebase + i.toString(10).padFunction("0",4) + "." + options.outputExt;
               if (options.bVerbose) {
                  console.log("urlString = " + urlString);
                  console.log("filePath = " + filePath);
               }
               getmapImage(filePath,urlString);
            }

            if (options.bCreatedataimage) {
                //canvas = createCanvas(0, 0);
                var filePath = options.dataoutputPath + options.dataoutputFilebase + i.toString(10).padFunction("0",4) + "." + options.dataoutputExt;
                if (options.bVerbose) {
                   console.log("filePath = " + filePath);
                }
                buildDataview(filePath, {
                    time: trip[0].time,
                    speed: 0.0,
                    topSpeed: 0.0,
                    avgSpeed: 0.0,
                    totalDistance: 0.0,
                    distanceTostart: 0.0,
                    bearing: 0.0,
                    elevation: (trip[0].ele * FEET_PER_METERS).toFixed(2),
                    elapsedTime: 0
                });
            }

            pathArray[pathIndex] = [];
            pathArray[pathIndex][0] = trip[index1].lat;
            pathArray[pathIndex][1] = trip[index1].lon;
            i = 1;
            while (i < options.duration) {
                var d;
                var index2;
                var index2r;
                if (Math.round(index1 + interval) >= trip.length) {
                    index2 = trip.length - 1;
                }
                else {
                    index2r = index1r + interval;
                    index2 = Math.round(index2r);
                }
                d = calcDistanceandBearing(trip[index1].lat,trip[index1].lon,
                                           trip[index2].lat,trip[index2].lon);
                toStart = calcDistanceandBearing(trip[0].lat,trip[0].lon,
                                           trip[index2].lat,trip[index2].lon);
                totalDistance += d.distance;
                var elapsedTime = (new Date(trip[index2].time) - new Date(trip[0].time))/1000;

                var timeDiff = (new Date(trip[index2].time) - new Date(trip[index1].time))/1000;
                var speed_fps = d.distance / timeDiff; /* feet per second */
                var speed_mph = speed_fps * MPH_CONVERSION_FACTOR;
                speed_max = Math.max(speed_max, speed_mph);
                speed_total = speed_total += speed_mph;
                speed_avg = speed_total / i;

                /* Convert elevation to feet - should add an option to determine units */
                var elevation = trip[index2].ele * FEET_PER_METERS;

                /* Need to add points to the path string for the call to Google Maps, this could get very long so I don't want to add every point
                   to the path.
                   Rules to add point to path:
                   - the current end point must added to the path, the question is if it is added to the end or replaces the current end
                   - replace if the bearing is not different enough based on bearingDelta
                   - else add
                */
                if ( Math.abs(d.bearing - currentBearing) > options.bearingDelta ) {
                    /* add */
                    pathIndex++;
                    pathArray[pathIndex] = [];
                    currentBearing = d.bearing;
                }
                pathArray[pathIndex][0] = trip[index2].lat;
                pathArray[pathIndex][1] = trip[index2].lon;
                var pathString = "path=color:" + options.pathColor + "|weight:" + options.pathWeight;
                if (options.encode) {
                    /* 10/28/2019 - Encoding not working, don't know why */
                    pathString = polyline.encode(pathArray);
                }
                else {
                    /* need to monitor the length, if it gets larger than 8K it won't work */
                    pathArray.forEach( function(point) {
                         pathString += ( "|" + point[0].toString(10) + "," + point[1].toString(10));
                    });
                }

                var urlString = createMapurl(trip[index2].lat,trip[index2].lon,pathString);

                if (options.bVerbose) {
                   console.log(i + ": index1 = " + index1 + " (" + trip[index1].lat + "," + trip[index1].lon + ") to index2 = " + index2 +
                            " (" + trip[index2].lat + "," + trip[index2].lon + ") = " + d.distance.toFixed(2) +
                            ", Bearing = " + d.bearing.toFixed(2) +
                            " Elevation = " + elevation +
                            " Total Distance (M) = " + (totalDistance / FEETMILES).toFixed(2) +
                            " Distance To Start = " + (toStart.distance / FEETMILES).toFixed(2) +
                            " Speed (MPH) = " + speed_mph.toFixed(2) + " time delta (secs) = " + timeDiff +
                            " Max Speed (MPH) = " + speed_max.toFixed(2) +
                            " Avg Speed (MPH) = " + speed_avg.toFixed(2));
                   console.log("urlString = " + urlString);
                }


                if (options.bCreateimage) {
                   var filePath = options.outputPath + options.outputFilebase + i.toString(10).padFunction("0",4) + "." + options.outputExt;
                   if (options.bVerbose) {
                      console.log("Map Output File: " + filePath);
                   }
                   getmapImage(filePath,urlString);
                }

                if (options.bCreatedataimage) {
                   var filePath = options.dataoutputPath + options.dataoutputFilebase + i.toString(10).padFunction("0",4) + "." + options.dataoutputExt;
                   if (options.bVerbose) {
                      console.log("Data Output File: " + filePath);
                   }
                   buildDataview(filePath, {
                       time: trip[index2].time,
                       speed: speed_mph.toFixed(2),
                       topSpeed: speed_max.toFixed(2),
                       avgSpeed: speed_avg.toFixed(2),
                       totalDistance: (totalDistance / FEETMILES).toFixed(2),
                       distanceTostart: (toStart.distance / FEETMILES).toFixed(2),
                       bearing: d.bearing.toFixed(2),
                       elevation: elevation.toFixed(2),
                       elapsedTime: elapsedTime
                   });
                }

                index1 = index2;
                index1r = index2r;
                i++;
            }
            console.log(" Complete: " + i + " records processed\n");
        }
        else {
            console.log("gpxData undefined");
        }
    })
    .catch(function(result) {
        console.log("[init] " + result);
        process.exit(-1);
    })
}

function loadData() {
    return new Promise (function(resolve,reject) {
        readFileAsync(options.inputFilename,{encoding: 'utf8'}).then(function(data) {
            var gpxData = parser.parse(data,{attributeNamePrefix: "", ignoreAttributes: false, parseAttributeValue: true});

            /* This can be a lot of data to write to the console */
            if (options.bVerboseData) {
               console.log(JSON.stringify(gpxData,null,3));
            }

            console.log(" Data timestamp: " + gpxData.gpx.metadata.time);

            if (options.bVerbose) {
               console.log("First data point: " + JSON.stringify(gpxData.gpx.trk.trkseg.trkpt[0],null,3));
            }

            resolve(gpxData);
        })
        .catch(function(err) {
           console.log("[loadData] Error: " + err);
           reject("Error reading data " + err);
        });
    });
}


function createMapurl(lat,lon,path) {

     var urlString = options.mapprotocol + "://"
                  + options.mapurl
                  + options.mapurlpath
                  + "?" + "key=" + GOOGLE_MAPS_API_KEY.key
                  + "&" + "format=" + options.outputExt
                  + "&" + "size=" + options.mapwidth + "x" + options.mapheight
                  + "&" + "zoom=" + options.mapzoom
     if (path) {
         urlString += "&" + path;
     }
     if (options.mapCenter) {
         urlString += "&" + "center=" + lat + "," + lon;
     }
     if (options.marker) {
         urlString += "&" + "markers=color:" + options.markerColor
                 + "|" + "size:" + options.markerSize
                 + "|" + lat + "," + lon;
     }

     return urlString;
}

/***************************************************************************************
   Calculate the distance between two gps points.

   I am not sure if this is right, need to test it.
   I got this algothrim from:  https://www.movable-type.co.uk/scripts/latlong.html

   This uses the ‘haversine’ formula to calculate the great-circle distance between two points –
   that is, the shortest distance over the earth’s surface – giving an ‘as-the-crow-flies’ distance
   between the points (ignoring any hills they fly over, of course!).

    Haversine
    formula:	a = sin²(Δφ/2) + cos φ1 ⋅ cos φ2 ⋅ sin²(Δλ/2)
    c = 2 ⋅ atan2( √a, √(1−a) )
    d = R ⋅ c
    where	φ is latitude, λ is longitude, R is earth’s radius (mean radius = 6,371km);
    note that angles need to be in radians to pass to trig functions!

    JavaScript:
    var R = 6371e3; // metres  Change to to feet
    var φ1 = lat1.toRadians();
    var φ2 = lat2.toRadians();
    var Δφ = (lat2-lat1).toRadians();
    var Δλ = (lon2-lon1).toRadians();

    var a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    var d = R * c;
***********************************************************************************************/

function calcDistanceandBearing(lat1,lon1,lat2,lon2) {
    var R = 3958.8 * 5280;  // radius of earth in ft
    var latr1 = toradians(lat1);
    var latr2 = toradians(lat2);
    var lat_delta_r = toradians(lat2-lat1);
    var lon_delta_r = toradians(lon2-lon1);

    var a = (Math.sin(lat_delta_r/2) * Math.sin(lat_delta_r/2)) +
            Math.cos(latr1) * Math.cos(latr2) *
            (Math.sin(lon_delta_r/2) * Math.sin(lon_delta_r/2));

    var c = 2 * Math.atan2(Math.sqrt(a),Math.sqrt(1-a));

    var distance = R * c;

    var y = Math.sin(lon_delta_r) * Math.cos(latr2);
    var x = Math.cos(latr1) * Math.sin(latr2) - Math.sin(latr1) * Math.cos(latr2) * Math.cos(lon_delta_r);

    /*
        Since atan2 returns values in the range -π ... +π (that is, -180° ... +180°), to normalise the result to a
        compass bearing (in the range 0° ... 360°, with −ve values transformed into the range 180° ... 360°),
        convert to degrees and then use (θ+360) % 360, where % is (floating point) modulo.
    */
    var bearing = (todegrees(Math.atan2(y, x)) + 360) % 360;

    return {distance: distance, bearing: bearing};  //I assume this is in ft, since R is in ft
}

function toradians(degrees) {
  return (degrees * (Math.PI/180));
}

function todegrees(radians) {
  return (radians * (180/Math.PI));
}

function buildDataview(filePath,data) {

  // Register a custom font
    if (options.localFontPath && options.localFontName) {
      registerFont(options.localFontPath, { family: options.localFontName });
    }

    /* don't love this, creating a new canvas each time */
    const canvas = createCanvas(0, 0);
    const ctx = canvas.getContext("2d");

    /* could also include a option to calculate the width and height based on
       the text size */
    canvas.width = options.infoview_width;
    canvas.height = options.infoview_height;

    /* Clear the canvas */
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const hasBorder =
        false ||
        options.borderLeftWidth ||
        options.borderTopWidth ||
        options.borderRightWidth ||
        options.borderBottomWidth;

      if (hasBorder) {
        ctx.fillStyle = options.borderColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      if (options.backgroundColor) {
        ctx.fillStyle = options.backgroundColor;
        ctx.fillRect(
          options.borderLeftWidth,
          options.borderTopWidth,
          canvas.width - (options.borderLeftWidth + options.borderRightWidth),
          canvas.height - (options.borderTopWidth + options.borderBottomWidth)
        );
      } else if (hasBorder) {
        ctx.clearRect(
          options.borderLeftWidth,
          options.borderTopWidth,
          canvas.width - (options.borderLeftWidth + options.borderRightWidth),
          canvas.height - (options.borderTopWidth + options.borderBottomWidth)
        );
      }

      ctx.globalAlpha = parseFloat(options.alpha);

      ctx.font = options.font;
      ctx.fillStyle = options.textColor;
      ctx.lineWidth = options.strokeWidth;
      ctx.strokeStyle = options.strokeColor;

      /* First draw the date and time */
      d = new Date(data.time);

      /* create date and time strings based on timezone
           -toLocaleString calculates timezone offset, dst, and day/month/year boundaries
      */
      var x;
      var y = options.dataTopmargin;
      if (d) {
        dateString = d.toLocaleString("en-US", {timeZone: options.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
        timeString = d.toLocaleString("en-US", {timeZone: options.timezone, hour: 'numeric', minute: 'numeric', second: 'numeric'});

        ctx.font = options.dateFont;

        /* I need to center the date and time on the canvas */
        ctx.textAlign = "center";
        ctx.textBaseline = 'hanging';
        x = (canvas.width / 2);
        ctx.fillText(dateString, x, y);

        var metrics = ctx.measureText(dateString);
        y = y + metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + options.timeSpacing;
        ctx.fillText(timeString, x, y);

        metrics = ctx.measureText(timeString);
        y = y + Math.floor(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);
      }

      /* Next the headers for the main display */
      ctx.font = options.headerFont;
      metrics = ctx.measureText(options.speedHeader + options.distanceHeader);

      /* center each header on half of the screen */
      ctx.textAlign = "center";
      var speed_x = (canvas.width / 4);
      var distance_x = canvas.width - (canvas.width / 4);

      y = y + options.headerSpacing;
      ctx.fillText(options.speedHeader,speed_x,y);
      ctx.fillText(options.distanceHeader,distance_x,y);
      y = y + Math.floor(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);


      /* Draw Speed
          - I might want the labels to be a small font but that will
            complicate things when centering the string
      */
      ctx.textBaseline = 'hanging';
      ctx.font = options.speeddistFont;
      var sp_metrics = ctx.measureText(data.speed);
      ctx.font = options.dataFont;
      var spl_metrics = ctx.measureText(options.speedLabel);
      var sp_width = sp_metrics.width + spl_metrics.width;
      x = speed_x - (sp_width/2);
      y = y + options.dataSpacing;
      ctx.font = options.speeddistFont;
      ctx.textAlign = "left";
      ctx.fillText(data.speed,x,y);
      var sp_y = y; // save for distance
      ctx.font = options.dataFont;
      x = x + sp_metrics.width + options.dataPadding;
      y = y + Math.floor(sp_metrics.actualBoundingBoxDescent-spl_metrics.actualBoundingBoxDescent);
      ctx.fillText(options.speedLabel,x,y);
      var spl_y = y;


      /* Draw distance */
      ctx.font = options.speeddistFont;
      var d_metrics = ctx.measureText(data.totalDistance);
      ctx.font = options.dataFont;
      var dl_metrics = ctx.measureText(options.distanceLabel);
      var d_width = d_metrics.width + dl_metrics.width;
      x = distance_x - (d_width/2);
      y = sp_y;
      ctx.font = options.speeddistFont;
      ctx.textAlign = "left";
      ctx.fillText(data.totalDistance,x,y);
      ctx.font = options.dataFont;
      x = x + d_metrics.width + options.dataPadding;
      y = spl_y;
      ctx.fillText(options.distanceLabel,x,y);

      y = y + Math.floor(dl_metrics.actualBoundingBoxDescent) + options.dataSpacing;

      /* Addtional Data - avg and top speed, distance to start */
      ctx.textAlign = "center";
      ctx.font = options.dataFont;
      var speedStr = options.avgSpeedlabel + " " + data.avgSpeed + "  " + options.topSpeedlabel + " " + data.topSpeed;
      var distStr = options.distStartlabel + " " + data.distanceTostart + " " + options.distanceLabel;
      metrics = ctx.measureText(speedStr + distStr);
      y = y + options.dataSpacing;
      ctx.fillText(speedStr,speed_x,y);
      ctx.fillText(distStr,distance_x,y);
      y = y + Math.floor(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent);

      /* Addtional Data - bearing, elevation, elapsed time */
      var locationStr = bearingToCompass(data.bearing) + "  " + options.elevationLabel + " " + data.elevation;
      var h = Math.floor(data.elapsedTime / 3600);
      var m = Math.floor((data.elapsedTime % 3600) / 60);
      var s = (data.elapsedTime % 3600) % 60;
      var timeStr = options.elapsedTimelabel + " " + h.toString(10).padFunction("0",2) + ":" + m.toString(10).padFunction("0",2) + ":" + s.toString(10).padFunction("0",2);
      y = y + options.dataSpacing;
      ctx.fillText(locationStr,speed_x,y);
      ctx.fillText(timeStr,distance_x,y);

      dataviewImage(filePath, canvas);
}

function bearingToCompass(bearing) {
     var dir;

     if (bearing > 340 || (bearing >= 0 && bearing <= 20)) {
         dir = "N";
     }
     else if (bearing > 20 && bearing <= 70) {
         dir = "NE";
     }
     else if (bearing > 70 && bearing <= 110) {
         dir = "E";
     }
     else if (bearing > 110 && bearing <= 160 ) {
         dir = "SE";
     }
     else if (bearing > 160 && bearing <= 200) {
         dir = "S";
     }
     else if (bearing > 200 && bearing <= 250) {
         dir = "SW";
     }
     else if (bearing > 250 && bearing <= 290) {
         dir = "W"
     }
     else if (bearing > 290 && bearing <= 340) {
         dir = "NW"
     }

     return dir;
}

function processCommandline(argv, params) {
   if (argv) {
      if (params == undefined) {
          params = new Object();
      }

      var i = 0;
      while (i < argv.length) {
         if (argv[i] == "-i") {
             params.inputFilename = argv[++i];
         }
         else if (argv[i] == "-mo") {
             params.outputFilebase = argv[++i];
         }
         else if (argv[i] == "-do") {
             params.dataoutputFilebase = argv[++i];
         }
         else if (argv[i] == "-t") {
             params.outputExt = argv[++i];
             if ( !format_types.includes(params.outputExt) ) {
                 console.log("Error: non supported format " + params.outputExt);
                 console.log("  Supported formats: " + JSON.stringify(format_types));
                 process.exit(-1);
             }
         }
         else if (argv[i] == "-op") {
             params.outputPath = argv[++i];
         }
         else if (argv[i] == "-dop") {
             params.dataoutputPath = argv[++i];
         }
         else if (argv[i] == "-d") {
             params.duration = parseInt(argv[++i]);
         }
         else if (argv[i] == "-bd") {
             params.bearingDelta = parseInt(argv[++i]);
         }
         else if (argv[i] == "-ni" || argv[i] == "--no_image") {
             params.bCreateimage = false;
         }
         else if (argv[i] == "-ndi" || argv[i] == "--no_data_image") {
             params.bCreatedataimage = false;
         }
         else if (argv[i] == "-tc" || argv[i] == "--text_color") {
             params.textColor = argv[++i];
         }
         else if (argv[i] == "-bc" || argv[i] == "--background_color") {
             params.backgroundColor = argv[++i];
         }
         else if (argv[i] == "-v" || argv[i] == "--verbose") {
             params.bVerbose = true;
         }
         else if (argv[i] == "-vd" || argv[i] == "--verbose_data") {
             params.bVerboseData = true;
         }
         i++;
      }
   }
}

function dataviewImage(filePath, canvas) {
   canvas.createPNGStream().pipe(fs.createWriteStream(filePath));
}


function getmapImage(filePath, url) {

   fetch(url).then(function(response) {
       /* save image file */
      var ws = fs.createWriteStream(filePath);
      ws.on('error', function(err) {
         console.log("[getmapImage]: " + err);
      });

      /* Initiate the source */
      response.body.pipe(ws);
   })
   .catch(function(err) {
      console.log("[getmapImage]: Error: " + err);
   });

}
