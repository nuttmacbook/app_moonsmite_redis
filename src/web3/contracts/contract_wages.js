// The smiths' wages contract: address of the PROXY (VITE_WAGES_ADDRESS), with the engine ABI.
// Source: WagesEngine.sol + WagesProxy.sol in this folder. Empty address = smith jobs stay off.
export const Wages = {
    address: import.meta.env.VITE_WAGES_ADDRESS,
    abi: [
        {
            "type": "error",
            "name": "AlreadyInitialized",
            "inputs": []
        },
        {
            "type": "error",
            "name": "OnlyOwner",
            "inputs": []
        },
        {
            "type": "error",
            "name": "FeeRequired",
            "inputs": []
        },
        {
            "type": "error",
            "name": "ZeroAddress",
            "inputs": []
        },
        {
            "type": "error",
            "name": "BillExpired",
            "inputs": []
        },
        {
            "type": "error",
            "name": "BillAlreadyPaid",
            "inputs": []
        },
        {
            "type": "error",
            "name": "BillSize",
            "inputs": []
        },
        {
            "type": "error",
            "name": "BillIsZero",
            "inputs": []
        },
        {
            "type": "error",
            "name": "NotSignedByGame",
            "inputs": []
        },
        {
            "type": "error",
            "name": "PaymentFailed",
            "inputs": []
        },
        {
            "type": "error",
            "name": "NothingToClaim",
            "inputs": []
        },
        {
            "type": "error",
            "name": "WagesLocked",
            "inputs": []
        },
        {
            "type": "error",
            "name": "Reentrant",
            "inputs": []
        },
        {
            "type": "event",
            "anonymous": false,
            "name": "OwnershipTransferred",
            "inputs": [
                {
                    "type": "address",
                    "name": "owner"
                },
                {
                    "type": "address",
                    "name": "newOwner"
                }
            ]
        },
        {
            "type": "event",
            "anonymous": false,
            "name": "SignerChanged",
            "inputs": [
                {
                    "type": "address",
                    "name": "signer"
                }
            ]
        },
        {
            "type": "event",
            "anonymous": false,
            "name": "TxFeeChanged",
            "inputs": [
                {
                    "type": "uint256",
                    "name": "txFee"
                }
            ]
        },
        {
            "type": "event",
            "anonymous": false,
            "name": "WagesPaid",
            "inputs": [
                {
                    "type": "bytes32",
                    "name": "billId",
                    "indexed": true
                },
                {
                    "type": "uint256",
                    "name": "tokenId",
                    "indexed": true
                },
                {
                    "type": "address",
                    "name": "payer",
                    "indexed": true
                },
                {
                    "type": "uint256",
                    "name": "total"
                },
                {
                    "type": "uint256",
                    "name": "smiths"
                }
            ]
        },
        {
            "type": "event",
            "anonymous": false,
            "name": "WagesClaimed",
            "inputs": [
                {
                    "type": "address",
                    "name": "account",
                    "indexed": true
                },
                {
                    "type": "uint256",
                    "name": "amount"
                }
            ]
        },
        {
            "type": "function",
            "name": "initialize",
            "constant": false,
            "payable": false,
            "inputs": [
                {
                    "type": "address",
                    "name": "owner_"
                },
                {
                    "type": "address",
                    "name": "coin_"
                },
                {
                    "type": "address",
                    "name": "signer_"
                }
            ],
            "outputs": []
        },
        {
            "type": "function",
            "name": "getProxyInfo",
            "constant": true,
            "stateMutability": "view",
            "payable": false,
            "inputs": [],
            "outputs": [
                {
                    "type": "address",
                    "name": ""
                },
                {
                    "type": "bool",
                    "name": ""
                }
            ]
        },
        {
            "type": "function",
            "name": "getDappInfo",
            "constant": true,
            "stateMutability": "view",
            "payable": false,
            "inputs": [],
            "outputs": [
                {
                    "type": "address",
                    "name": ""
                },
                {
                    "type": "address",
                    "name": ""
                },
                {
                    "type": "uint256",
                    "name": ""
                },
                {
                    "type": "uint256",
                    "name": ""
                },
                {
                    "type": "uint256",
                    "name": ""
                },
                {
                    "type": "uint256",
                    "name": ""
                }
            ]
        },
        {
            "type": "function",
            "name": "getSmithInfo",
            "constant": true,
            "stateMutability": "view",
            "payable": false,
            "inputs": [
                {
                    "type": "address",
                    "name": "account_"
                }
            ],
            "outputs": [
                {
                    "type": "tuple",
                    "name": "",
                    "components": [
                        {
                            "type": "uint256",
                            "name": "claimable"
                        },
                        {
                            "type": "uint256",
                            "name": "claimed"
                        },
                        {
                            "type": "uint256",
                            "name": "earned"
                        }
                    ]
                }
            ]
        },
        {
            "type": "function",
            "name": "isBillPaid",
            "constant": true,
            "stateMutability": "view",
            "payable": false,
            "inputs": [
                {
                    "type": "bytes32",
                    "name": "billId_"
                }
            ],
            "outputs": [
                {
                    "type": "bool",
                    "name": ""
                }
            ]
        },
        {
            "type": "function",
            "name": "pay",
            "constant": false,
            "stateMutability": "payable",
            "payable": true,
            "inputs": [
                {
                    "type": "tuple",
                    "name": "bill_",
                    "components": [
                        {
                            "type": "uint256",
                            "name": "tokenId"
                        },
                        {
                            "type": "address[]",
                            "name": "smiths"
                        },
                        {
                            "type": "uint256[]",
                            "name": "amounts"
                        },
                        {
                            "type": "bytes32",
                            "name": "billId"
                        },
                        {
                            "type": "uint256",
                            "name": "deadline"
                        }
                    ]
                },
                {
                    "type": "bytes",
                    "name": "sig_"
                }
            ],
            "outputs": []
        },
        {
            "type": "function",
            "name": "claim",
            "constant": false,
            "stateMutability": "payable",
            "payable": true,
            "inputs": [],
            "outputs": []
        },
        {
            "type": "function",
            "name": "setSigner",
            "constant": false,
            "payable": false,
            "inputs": [
                {
                    "type": "address",
                    "name": "signer_"
                }
            ],
            "outputs": []
        },
        {
            "type": "function",
            "name": "setTxFee",
            "constant": false,
            "payable": false,
            "inputs": [
                {
                    "type": "uint256",
                    "name": "txFee_"
                }
            ],
            "outputs": []
        },
        {
            "type": "function",
            "name": "transferOwnership",
            "constant": false,
            "payable": false,
            "inputs": [
                {
                    "type": "address",
                    "name": "newOwner"
                }
            ],
            "outputs": []
        },
        {
            "type": "function",
            "name": "transferETH",
            "constant": false,
            "payable": false,
            "inputs": [
                {
                    "type": "address",
                    "name": "to"
                },
                {
                    "type": "uint256",
                    "name": "amount"
                }
            ],
            "outputs": []
        },
        {
            "type": "function",
            "name": "transferToken",
            "constant": false,
            "payable": false,
            "inputs": [
                {
                    "type": "address",
                    "name": "token"
                },
                {
                    "type": "address",
                    "name": "to"
                },
                {
                    "type": "uint256",
                    "name": "amount"
                }
            ],
            "outputs": []
        },
        {
            "type": "receive",
            "stateMutability": "payable"
        }
    ],
};
