var AWS = require('aws-sdk');
var parseArgs = require('minimist');
var _ = require('lodash');
var async = require('async');

function watchDeployment(route, args) {
	var opts = parseArgs(args);
	var CodeDeploy = new AWS.CodeDeploy({
		region: opts.region || 'us-east-1'
	});
	var verbose = opts.verbose;

	var deploymentId = opts._[0];

	var maxWait = Number(opts.timeout || 600) * 1000;
	var interval = Number(opts.interval || 5) * 1000;
	var startTime = Date.now();
	var nick = route.nick;

	if (!deploymentId) {
		route.send('?codedeploy_missing_deployment_id');
		return;
	}

	var previous;

	function watchLoop() {
		var elapsed = Date.now() - startTime;
		if (elapsed > maxWait) {
			console.log('Timeout exceeded');
			route.send('?codedeploy_timeout', nick, deploymentId);
			return;
		}

		CodeDeploy.getDeployment({
			deploymentId: deploymentId
		}, function(err, data) {
			console.log('getDeployment:', err, data);
			if (err) {
				route.send('?codedeploy_request_failed', deploymentId, err);
				return;
			}
			var deploymentInfo = data.deploymentInfo;

			switch (data.deploymentInfo.status) {
				case 'Succeeded':
					route.send('?codedeploy_deployment_succeeded', nick, deploymentId);
					return;
				case 'Failed':
					route.send('?codedeploy_deployment_failed', nick, deploymentId);
					return;
				case 'Stopped':
					route.send('?codedeploy_deployment_stopped', nick, deploymentId);
					return;
				case 'Created':
				case 'Queued':
				case 'InProgress':
					if (!previous || !_.isEqual(previous.deploymentOverview, deploymentInfo.deploymentOverview)) {
						route.send('?codedeploy_deployment_progress', deploymentId, JSON.stringify(deploymentInfo.deploymentOverview));
					}
					previous = deploymentInfo;
					setTimeout(watchLoop, interval);
			}
		});
	}

	watchLoop();
}

function describeApplication(route, args) {
	var opts = parseArgs(args);
	var CodeDeploy = new AWS.CodeDeploy({
		region: opts.region || 'us-east-1'
	});

	var nick = route.nick;
	var applicationId = opts._[0];
	if (!applicationId) {
		route.send('?codedeploy_missing_application_id');
		return;
	}

	async.seq(
		CodeDeploy.listDeploymentGroups.bind(CodeDeploy),
		//list the deployments for each deployment group
		function(deploymentGroupsResponse, callback) {
			var getDeploymentGroupsDeployments = _.map(deploymentGroupsResponse.deploymentGroups, function(deploymentGroup) {
				return CodeDeploy.listDeployments.bind(CodeDeploy, {
					applicationName: applicationId,
					deploymentGroupName: deploymentGroup,
					includeOnlyStatuses: ['Created', 'Queued', 'InProgress', 'Succeeded']
				});
			});
			async.parallel(getDeploymentGroupsDeployments, callback);
		},
		//gets the status of the head deployment for each deployment group
		function(listDeploymentsResponses, callback) {
			var getDeploymentsInfo = _.map(listDeploymentsResponses, function(deploymentsResponse) {
				return CodeDeploy.getDeployment.bind(CodeDeploy, {
					deploymentId: _.head(deploymentsResponse.deployments)
				});
			});
			async.parallel(getDeploymentsInfo, callback);
		}
	)({
		applicationName: applicationId
	}, function(err, deploymentsResponses) {
		if (err) {
			route.send('?codedeploy_describe_application_error', nick, applicationId, err);
			return;
		}
		var digest = _.map(deploymentsResponses, function(deploymentResponse) {
			return _.pick(deploymentResponse.deploymentInfo, 'deploymentGroupName', 'deploymentId', 'completeTime',
				'revision');
		});
		route.send('?codedeploy_describe_application_success', nick, applicationId, JSON.stringify(digest, null, 2));
	});

};

module.exports = {
	displayname: 'CodeDeploy',
	description: 'Monitor your deployments.',

	commands: [{
		name: 'CodeDeploy Application',
		description: 'Gives information about the deployed revisions for a application',
		usage: 'google [more] (search terms)',
		trigger: /codedeploy application/i,
		func: describeApplication
	}, {
		name: 'CodeDeploy Deployment',
		description: 'Watches a deployment progress',
		usage: 'codedeploy deployment (deployment id)',
		trigger: /codedeploy deployment/i,
		func: watchDeployment
	}]
};
