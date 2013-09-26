/**
 * Author: krasu
 * Date: 9/19/13
 * Time: 11:20 AM
 */
var git = require('./git-request'),
	mongoose = require('mongoose'),
	async = require('async'),
	io = require('./socket.io'),
	_ = require('lodash'),
	Project = mongoose.model('Project'),
	Organization = mongoose.model('Organization'),
	Support = mongoose.model('Support'),
	User = mongoose.model('User'),
	ioNamespace = '/projects-update/status'

function ProjectsUpdater(user) {
	if (!(this instanceof ProjectsUpdater))
		return new ProjectsUpdater(user);

	this.user = user
	this.reqestParams = {
		access_token: this.user.authToken
	}

	this.user.projectsUpdater.updated = false
	this.user.projectsUpdater.updating = true
	this.user.save(_.bind(function () {
		this.fetch()
	}, this))
}

ProjectsUpdater.prototype.progress = function (desc) {
	io().of(ioNamespace).in(this.user._id).emit('progress', desc)
}

ProjectsUpdater.prototype.finish = function () {
	var self = this
	this.updateUser('success', function () {
		io().of(ioNamespace).in(self.user._id).emit('done')
	})
}

ProjectsUpdater.prototype.error = function (desc, error) {
	var self = this
	console.error(desc, error)
	this.updateUser('error', function () {
		io().of(ioNamespace).in(self.user._id).emit('error', desc, error)
	})
}

ProjectsUpdater.prototype.updateUser = function (status, callback) {
	this.user.projectsUpdater.updated = true
	this.user.projectsUpdater.updating = false
	this.user.projectsUpdater.updatedAt = new Date()
	this.user.projectsUpdater.status = status
	this.user.save(callback)
}

ProjectsUpdater.prototype.updateEntryAdmins = function (entry, add) {
	entry.admins = (entry.admins || [])
	entry.admins = _.filter(entry.admins, function (id) {
		return this.user.id.toString() != id.toString()
	}, this)

	if (add) entry.admins.push(this.user._id)

	return entry
}

ProjectsUpdater.prototype.fetch = function () {
	var self = this

	async.parallel([
		function (callback) {
			git.request('user/orgs', self.reqestParams, function (err, data) {
				if (err) return callback(err)

				async.each(data, function (entry, cb) {
					entry = Organization.parseGitHubData(entry)
					self.fetchOrgRepos(entry, cb)
				}, callback)
			})
		},
		function (callback) {
			git.requestRepos('user/repos', _.merge({}, self.reqestParams, {
				type: 'owner'
			}), function (err, data) {
				if (err) return callback(err)

				_.each(data, function (repo) {
					repo.owner.user = self.user._id
				})

				self.updateRepos(data, self.user.github.id, function (error) {
					if (!error) self.progress('updated info about repos you maintaining')
					callback(error)
				})
			})
		}
	], function (error) {
		if (error) return self.error('failed updating maintaining repos', error)
		self.finish()
	})
}

ProjectsUpdater.prototype.fetchOrgRepos = function (org, callback) {
	var self = this

	git.requestRepos('orgs/' + org.name + '/repos', self.reqestParams, function (err, entries) {
		if (err) return callback(err)

		var isAdmin = false,
			repos = _.map(entries, function (entry) {
				if (entry.githubData.permissions.admin) {
					isAdmin = true
					entry.admins = [self.user._id]
				}
				return entry
			})

		async.waterfall([
			async.apply(_.bind(self.updateOrganization, self), org, isAdmin),
			function () {
				var org = arguments[0],
					callback = Array.prototype.pop.call(arguments)

				repos = _.each(repos, function (entry) {
					entry.owner.org = org._id
				})
				self.updateRepos(repos, org.githubId, callback)
			}
		], function (error) {
			if (!error) self.progress('updated info for "' + org.name + '" organization')
			callback(error)
		})
	})
}

ProjectsUpdater.prototype.updateOrganization = function (org, isAdmin, callback) {
	var self = this

	Organization.findOne({ githubId: org.githubId }, function (err, entry) {
		if (err) return callback(err);

		if (!entry) return Organization.create(org, callback)

		self.updateEntryAdmins(entry, isAdmin)
		entry.save(callback)
	})
}

ProjectsUpdater.prototype.updateRepos = function (gitRepos, ownerGithubId, callback) {
	var self = this

	Project.find({
		githubId: { $in: _.pluck(gitRepos, 'githubId')},
		'owner.githubId': ownerGithubId
	}, function (err, entries) {
		if (err) return callback(err);

		if (!entries.length) return Project.create(gitRepos, callback)

		var removed = _.filter(entries, function (entry) {
			return !_.find(gitRepos, {githubId: entry.githubId})
		})

		var created = _.filter(gitRepos, function (entry) {
			return !_.find(entries, {githubId: entry.githubId})
		})

		var updated = _.compact(_.map(gitRepos, function (repo) {
			var entry = _.find(entries, {githubId: repo.githubId})
			if (!entry) return

			entry = _.merge(entry, _.omit(repo, 'admins'))

			self.updateEntryAdmins(entry, _.find(repo.admins, function (v) {
				return v + '' == self.user._id + ''
			}))

			return entry
		}))

		async.parallel([
			function (cb) {
				Project.create(created, cb)
			},
			function (cb) {
				Project.remove({ githubId: { $in: _.pluck(removed, 'githubId')}, 'owner.githubId': ownerGithubId }, cb)
			},
			function (cb) {
				async.each(updated, function (entry, c) {
					entry.save(c)
				}, cb)
			}
		], callback)
	})
}

module.exports = ProjectsUpdater