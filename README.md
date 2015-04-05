# Quagga-Net-Sim
This software automates the creation of virtual Quagga routers for network simulation. It is written in Node.js. The file config.json contains the network topology, and this topology is created by running app.js.

#### Installing Quagga

    sudo apt-get install git gcc make autoconf automake libtool gawk texinfo
    
    git clone https://github.com/opensourcerouting/quagga.git

    sudo useradd quagga
    sudo mkdir /usr/local/quagga
    sudo chown quagga:quagga /usr/local/quagga

    cd quagga
    ./bootstrap.sh
    ./configure --sysconfdir=/usr/local/quagga --localstatedir=/usr/local/quagga
    make
    sudo make install

#### Starting the software

    sudo ./app.js

#### Testing the network
You will probably have to wait thirty seconds or so for the routers to exchange links before Client_2 becomes reachable.

    sudo ip netns exec Client_1 traceroute 30.0.0.1


#### Stopping the software

    ./apps.js stop