#!/usr/bin/env node

/*

  1. Run app.js, kills itself, reruns itself in background with daemon
  2. Each additional time it is run, it checks if it is already running
  3. If it is, it instead sends http post commands to running instance

*/
var async = require('async');
var exec = require('child_process').exec;
var fs = require('fs');
var http = require('http');
var url = require('url');

var config = JSON.parse(fs.readFileSync('config.json'));

const PORT = 8080;

async.series([
  checkIfRunning,
  checkIfRoot,
  beginDaemon,
  setupNetns,
  startServer
]);

/*
Checks to see if the daemon/server is already running.
If it is not, it starts it. If it is, it sends arguments
as GET variables to the daemon.
*/
function checkIfRunning(callback){
  //check if http server is running, if so send get request
  var options = {host: 'localhost', port: PORT, path: '/', agent:false}; 
  http.get(options, function(res) {
    //Make get request with args
    var extraArgs = false;
    var getString='/'
    for(var i = 0; i < process.argv.length; i++){
      if(extraArgs){
        getString += process.argv[i] +'/';
      }else if(process.argv[i].split('/').indexOf('app.js')!=-1){
        extraArgs=true;
      }
    }
    options = {host: 'localhost', port: PORT, path: getString, agent:false};
    http.get(options, function(res) {
      var str='';
      res.on('data', function (chunk) {
        str += chunk;
      });
      res.on('end', function () {
        console.log(str);
      });

    })
    callback('Exit');
  }).on('error', function(e) {
    //Server not running
    callback();
  });
}
/*
  Make sure the process is started as root
*/
function checkIfRoot(callback){
  exec('whoami', function (error, name, stderr) {
    if(name!='root\n'){
      console.log('\nMust started with root privledges\n');
      callback('Exit');
    }else{

      callback();
    }
  })
}
/*
  Begin running the daemon
*/
function beginDaemon(callback){
  require('daemon')();
  callback();
}
/*

*/
function setupNetns(callback){
  //For each host, create a corresponding network namespace based on the index
  commandQueue = []
  for(var i = 0; i < config.hosts.length; i++){
    commandQueue.push('ip netns add ' + config.hosts[i].name);
    //If it uses zebra, create new folder in usr/local/quagga
    if(config.hosts[i].protocol){
      commandQueue.push('mkdir /usr/local/quagga/' + config.hosts[i].name);
    }
    config.hosts[i].links = [];
  }
  //For each link create veth pair and add to correct netns
  for(var i = 0; i < config.links.length; i++){
    var index1 = getIndexByName(config.links[i][0].host);
    var index2 = getIndexByName(config.links[i][1].host);
    var link1 = String(index1) + '-' + String(index2);
    var link2 = String(index2) + '-' + String(index1);
    //add link info to the host object for easier retreval later, maybe should be done in separate step for clarity
    config.hosts[index1].links.push({link:i, me: 0, otherIndex: index2, name:link1});
    config.hosts[index2].links.push({link:i, me: 1, otherIndex: index1, name:link2});
    commandQueue.push('ip link add ' + link1 + ' type veth peer name ' + link2);
    commandQueue.push('ip link set ' + link1 + ' netns ' + config.links[i][0].host);
    commandQueue.push('ip link set ' + link2 + ' netns ' + config.links[i][1].host);
  }
  for(var i = 0; i < config.hosts.length; i++){
    if(config.hosts[i].protocol){
      //For the zebra hosts
      //Create the config files
      //Make zebra.conf
      var zebraConf = [
        'hostname ' + config.hosts[i].name, 
        'password zebra',
        'enable password zebra'
      ]
      zebraConf = zebraConf.concat([
        'interface lo',
        '  link-detect',
        '  ip address ' + config.hosts[i].protocol.lo,
      ])
      for(var j = 0; j < config.hosts[i].links.length; j++){
        var hostLink = config.hosts[i].links[j];
        var link = config.links[hostLink.link];
        var client = link[hostLink.me];
        zebraConf = zebraConf.concat([
        'interface ' + hostLink.name,
        '  link-detect',
        '  ip address ' + client["ip address"],
      ])
      }
      zebraConf = zebraConf.concat([
        'ip forwarding',
        'line vty',
        'end'
      ])
      commandQueue.push('echo "' + zebraConf.join('\n') + '" > /usr/local/quagga/' + config.hosts[i].name +'/zebra.conf')
      var startDaemon = '';
      if(config.hosts[i].protocol.type == 'ospf'){
        var startDaemon = 'ospfd -d';
        //create ospfd.conf
        var ospfdConf = [
          'hostname ' + config.hosts[i].name + '_OSPF', 
          'password zebra',
          'enable password zebra',
          'router ospf',
          '  ospf router-id ' + config.hosts[i].protocol["router id"],
          '  network ' + config.hosts[i].protocol.lo + ' area 0'
        ]
        for(var j = 0; j < config.hosts[i].links.length; j++){
          var hostLink = config.hosts[i].links[j];
          var link = config.links[hostLink.link];
          var network = getNetwork(link[0]["ip address"])
          ospfdConf.push('  network ' + network + ' area 0')
        }
        commandQueue.push('echo "' + ospfdConf.join('\n') + '" > /usr/local/quagga/' + config.hosts[i].name +'/ospfd.conf')
      }
      //Begin running the process
      var startCommand = 'ip netns exec ' + config.hosts[i].name + ' /bin/bash -c \'';
      var startCommands = [
        'mount -o bind /usr/local/quagga /usr/local/quagga',
        'mount --make-private /usr/local/quagga',
        'mount -o bind /usr/local/quagga/' + config.hosts[i].name + ' /usr/local/quagga',
        'chown quagga /usr/local/quagga',
        'zebra -d',
        startDaemon,
      ]
      startCommand += startCommands.join(';') +'\''
      commandQueue.push(startCommand)

    }else{
      //For the non zebra hosts
      //Set the links up
      //Apply the flags, in this case just gateway
      commandQueue.push('ip netns exec ' + config.hosts[i].name + ' ip link set dev lo up');
      for(var j = 0; j < config.hosts[i].links.length; j++){
        var hostLink = config.hosts[i].links[j];
        var link = config.links[hostLink.link];
        var client = link[hostLink.me];
        commandQueue.push('ip netns exec ' + config.hosts[i].name + ' ip link set dev '+ hostLink.name +' up');
        commandQueue.push('ip netns exec '+ config.hosts[i].name +' ip addr add '+ client["ip address"] +' dev ' + hostLink.name);
        if(client.gateway){
          commandQueue.push('ip netns exec '+ config.hosts[i].name +' ip route add default via ' + client.gateway);
        }
      }
    }
  }
  runCommands(function(){
    callback();
  },commandQueue)
}
/*
  Begin running the server
*/
function startServer(callback){
  var server = http.createServer(function (request, response) {

    var params = request.url.split('/');
    params.splice(0,1);
    params.splice(params.length-1,1)

    if(params.length==0){
      handleHelp(response)
    }else{
      if(params[0] == 'stop'){
        handleStop(response)
      }else{
        handleHelp(response);
      }
    }
  });

  server.listen(PORT);
}

function handleHelp(response){

  response.writeHead(200, {"Content-Type": "text/plain"});
  var usage = [
    'Usage:',
    'stop\t stops the server',
    'help\t brings up this dialogue'
  ]
  response.end(usage.join('\n'));

}

function handleStop(response){

  response.writeHead(200, {"Content-Type": "text/plain"});
  response.end('Stopping Server');

  var commandQueue = [];

  //kill all zebra and daemon instances
  for(var i = 0; i < config.hosts.length; i++){
    if(config.hosts[i].protocol){
      commandQueue.push('kill -TERM $(cat /usr/local/quagga/' + config.hosts[i].name + '/zebra.pid)');
      if(config.hosts[i].protocol.type == "ospf"){
        commandQueue.push('kill -TERM $(cat /usr/local/quagga/' + config.hosts[i].name + '/ospfd.pid)');
      }
    }
  }


  //delete all network namespaces and conf files/folders
  for(var i = 0; i < config.hosts.length; i++){
    commandQueue.push('ip netns delete ' + config.hosts[i].name);
    if(config.hosts[i].protocol){
      commandQueue.push('rm -r /usr/local/quagga/' + config.hosts[i].name);
      //create zebra.conf
      //create daemon conf if it uses one
    }
  }
  runCommands(function(){
    process.exit();
  },commandQueue)

}

function getIndexByName(hostName){
  for(var i = 0; i<config.hosts.length; i++){
    if(config.hosts[i].name == hostName){
      return i; 
    }
  }
}

function runCommands(callback,commandQueue){
  if(commandQueue.length > 0){
    console.log(commandQueue[0])
    exec(commandQueue[0],function (error, output, stderr) {
      log(commandQueue[0]);
      console.log(error,output)
      commandQueue = commandQueue.slice(1,commandQueue.length);
      runCommands(callback,commandQueue)
    })
  }else{
    callback();
  }
}

function log(string){
  fd = fs.openSync('server.log', 'a')
  fs.writeSync(fd, string + '\n')
  fs.closeSync(fd)
}

function getNetwork(ip){
  var netmask = ip.split('/')[1];
  var address = ip.split('/')[0];

  var binaryAddress = addressToBinary(address);
  var binaryNetmask = getNetmask(netmask)
  var binaryNetwork = binaryAnd(binaryAddress,binaryNetmask);
  network = binaryToAddress(binaryNetwork);


  return network +'/'+netmask;
}

function addressToBinary(address){
  address = address.split('.');
  binary = '';
  for(var i = 0; i < 4; i++){
    binary += decimalToBinary(address[i],8);
  }
  return binary
}

function binaryToAddress(binaryAddress){
  var address = []
  for(var i =0; i < 4; i++){
    address.push(binaryToDecimal(binaryAddress.substring(8*i,8*i+8)));
  }
  address = address.join('.');
  return address
}

function getNetmask(netmask){
  var result = '';
  for(var i = 0; i < netmask; i++){
    result += '1'
  }
  while(result.length < 32){
    result += '0'
  }
  return result
}

function binaryToDecimal(binary){
  var decimal = 0;
  factor = Math.pow(2,binary.length-1);
  for(var i = 0; i < binary.length; i++){
    decimal += Number(binary.charAt(i)) * factor
    factor /= 2;
  }
  return decimal;
}

function decimalToBinary(decimal, numBits){
  if(numBits == undefined){
    numBits = Math.max(Math.ceil(Math.log(decimal+1)/Math.log(2)),1)
  }
  binString = '';
  var factor = Math.pow(2,numBits-1)
  for(var i = 0; i < numBits; i ++){
    if(factor <= decimal){
      binString+='1'
      decimal -= factor
    }else{
      binString+='0'
    }
    factor = factor / 2;
  }
  return binString;
}

function binaryAnd(binary1, binary2){
  var result = '';
  for(var i = 0; i < binary1.length; i++){
    if(binary1.charAt(i) == '1' && binary2.charAt(i) == '1'){
      result +='1';
    }else{
      result += '0';
    }
  }
  return result;
}