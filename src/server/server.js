var express = require('express');
var path = require('path');
var bodyParser = require('body-parser');
var mongoose = require('mongoose');
var middleware = './middleware/middleware';
var stormpath = require('express-stormpath');
var Eventbrite = require('eventbrite-node');
var config = require('../config/eventbrite');
var Event = require('./models/event');
var User = require('./models/user');
var Promo = require('./models/promo');
var client = new Eventbrite(config.clientKey, config.clientSecret);
var moment = require('moment');

//Alias for heroku ports/db vs local
var PORT = process.env.PORT || 8080;
var db =  process.env.MONGODB_URI || 'mongodb://localhost/PartyParrot';
mongoose.connect(db);

//mongoose's promise library is depricated.
mongoose.Promise = global.Promise;
var app = express();

// Setups stormpath. The application:{href: https://..} is unique to the
// storm path application being used to do the authentication for this app.
// Please change this for your application
app.use(stormpath.init(app, {
  application:{
    href: 'https://api.stormpath.com/v1/applications/38BYzfpt1mubNI49Sj9nC4'
  },
  website: true
}));
app.use(bodyParser.json());
app.use(express.static(__dirname + '/../public'));

app.get('/parrot', function(req,res){
  res.sendFile(path.join(__dirname, '/../public/parrot.html'));
})

//In the interest of time and speed we created one schema to avoid joins
app.post('/create',stormpath.loginRequired, function(req,res){
  Event.find({}, 'eventbrite', function(err, events){
    if (err) {
      console.log("ERR: ", err);
    } else {
      var ids = events.map(function(event){
        return event.eventbrite.id;
      }).filter(function(id){
        return id === req.body.event.id;
      });
      if (ids.length) { // sends error if event already taken
        res.status(500).json({error: "Event Taken"});
      } else { // creates event if not a duplicate
        var event = new Event({
        name: req.body.event.name.text,
        desc: req.body.event.description.text,
        promoters: [req.user.fullName],
        owner: req.user.username,
        gPoint: req.body.gPoint,
        gReward: req.body.gReward,
        sPoint: req.body.sPoint,
        sReward: req.body.sReward,
        bPoint: req.body.bPoint,
        bReward: req.body.bReward,
        eventbrite: req.body.event
        });
        event.save(function (err, post) {
          if (err) console.error(err);
          res.status(201).json('Hey I posted ' + post);
        });
      }
    }
  });
});

// Returns all events independent of what user is logged in
app.get('/events',stormpath.loginRequired, function (req, res, next) {
  Event.find(function(err, events) {
    if (err) { console.error(err) }
    res.json(events);
  })
  // Create user object with all of user's info
  var createdAt = moment(req.user.createdAt.slice(0,10));
  console.log('$$$$$ createdAt with moment: ', createdAt);
  var user = new User({
    username: req.user.username,
    firstName: req.user.givenName,
    lastName: req.user.surname,
    fullName: req.user.fullName,
    memberSince: createdAt
  });
  // Check User Model for User. If !User, then save.
  User.findOne({username: req.user.username}, function(err,doc){
    if (err) {
      console.error(error)
    }
    // If no document found, update user database with user info
    if (doc === null){
      user.save(function(err,post){
        if (err) {console.error(err)}
      });
    }
  });
});

// Returns events that only the user who is logged in has created
app.get('/userEvents', stormpath.loginRequired, function(req,res) {
  Event.find({'owner': req.user.username}, function(err, event) {
    if (err) console.error(err);
    res.json(event);
  })
})

// Returns user profile data for only the user who is logged in
app.get('/userProfile', stormpath.loginRequired, function(req,res) {
  User.find({'username': req.user.username}, function(err, user) {
    if (err) console.error(err);
    res.json(user);
  })
})

// This is a hack to pass over username from stormpath to client side
app.get('/secrets', stormpath.loginRequired, function(req,res){
  // console.log(req.user.username)
  res.json(req.user.username);
})


// Will return array of all promoters for a specified event
// Expects "/eventid" in the url
// returns [{link: "bitlyLink", fullName: "Full Name"}]
// returns empty array [] if no promoters
app.get('/promoters/:event', stormpath.loginRequired, function(req, res){
  Promo.find({'event': req.params.event}, 'link fullName', function(err, promos){
    if (err) {
      console.log("Error: ", err);
      res.status(500).send({error: err});
    } else {
      res.json(promos);
    }
  });
});


// Adds new entry to promo table for event/promoter combo with unique link
// Expects {event: "eventname", link: "bitlyLink"}
app.post('/promoter', stormpath.loginRequired, function(req, res){
  var newPromoterObj = req.body;
  newPromoterObj.promoter = req.user.username;
  newPromoterObj.fullName = req.user.fullName;

  Promo.create(newPromoterObj, function(err, promo){
    if (err) {
      console.log("Error: ", err);
      res.status(500).send({error: err});
    } else {
      res.status(200);
    }
  });
});


// Will return a single promoter object for a specified event
// Expects "/eventid" in the url
// if already a promoter, returns {link: "bitlyLink"}
// if not yet a promoter, returns {userid: 'id', link: null}
app.get('/promoter/:event', stormpath.loginRequired, function(req, res){
  Promo.findOne({'event': req.params.event, 'promoter': req.user.username}, 'link', function(err, promo){
    if (err) {
      console.log("Error: ", err);
      res.status(500).send({error: err});
    } else {
      if (!promo) { // current user is not a promoter for this event
        User.findOne({'username': req.user.username}, function(err, user){
          if (err) {
            console.log("Error: ", err);
            res.status(500).send({error: err});
          } else {  // return userid and bitly link
            res.json({'userid': user['_id'], 'link': null});
          }
        });
      } else { // return bitly link
        res.json({'link': promo.link});
      }
    }
  });
});


// Will return user's bitly and event for each promoted event
// returns [{link: bitlyLink, gS: #, sS: #, bS: #, event: eventbrite}]
// returns empty array [] if no promoted events
app.get('/scores', stormpath.loginRequired, function(req, res){
  Promo.find({'promoter': req.user.username}, 'event link', function(err, promos){
    if (err) {
      console.log("Error: ", err);
      res.status(500).send({error: err});
    } else {
      Event.find({}, 'eventbrite gpoint gPoint sPoint bPoint', function(err, events){
        if (err) {
          console.log("Error: ", err);
          res.status(500).send({error: err});
        } else {
          var results = events.reduce(function(results, event){
            for (var i=0; i<promos.length; i++){
              if (promos[i].event === event.eventbrite.id) {
                // var modEvent = event;
                // modEvent.link = promos[i].link;
                return results.concat({
                  link: promos[i].link,
                  eventbrite: event.eventbrite,
                  gPoint: event.gPoint,
                  sPoint: event.sPoint,
                  bPoint: event.bPoint
                });
              }
            }
            return results;
          }, []);
          res.json(results);
        }
      });
    }
  });
});


// If no app.get path was found for request, this is the default, which will
// then use the react router
app.get('*', function (req, res) {
 res.sendFile(path.join(__dirname, '/../public/index.html'));
});



//Eventbrite auth. Currently single user.
app.get('/authentication', function(req, res){
  var authUrl = client.getOAuthUrl();
  res.redirect(authUrl);
  client.authorize(req.query.code, function(err, response) {
    if (err) {
      console.log.error(err);
      return;
    }
    console.log(response.access_token);
  });
});

//This is an entry point for stormpath integration.
app.on('stormpath.ready', function() {
  app.listen(PORT);
});

module.exports = app;
