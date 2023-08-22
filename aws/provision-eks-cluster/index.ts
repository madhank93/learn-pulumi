import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'

// Grab some values from the Pulumi configuration (or use default values)
const config = new pulumi.Config()
const minClusterSize = config.getNumber('minClusterSize') || 3
const maxClusterSize = config.getNumber('maxClusterSize') || 6
const desiredClusterSize = config.getNumber('desiredClusterSize') || 3
const eksNodeInstanceType = config.get('eksNodeInstanceType') || 't3.medium'
const vpcNetworkCidr = config.get('vpcNetworkCidr') || '10.0.0.0/16'

// Creating VPC
const eksVpc = new aws.ec2.Vpc('eks-vpc', {
  tags: {
    name: 'my-eks-vpc',
  },
  cidrBlock: vpcNetworkCidr,
})

// Subnet cidr block range
const privateSubnetCidrBlock = ['10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24']
const publicSubnetCidrBlock = [
  '10.0.101.0/24',
  '10.0.102.0/24',
  '10.0.103.0/24',
]

// Helper function to create subnets
const createSubnetAndGetID = (
  cidrRange: string,
  index: number,
  isPublic: boolean
) =>
  new aws.ec2.Subnet(`${isPublic ? 'public' : 'private'}-subnet-${index}`, {
    vpcId: eksVpc.id,
    cidrBlock: cidrRange,
    mapPublicIpOnLaunch: isPublic,
    availabilityZone: index / 2 == 0 ? 'us-west-2a' : 'us-west-2b',
    tags: {
      name: 'my-eks-subnets',
    },
  }).id

// Create private subnet
const privateSubnet = privateSubnetCidrBlock.map((subnet, index) =>
  createSubnetAndGetID(subnet, index, false)
)

// Create public subnet
const publicSubnet = publicSubnetCidrBlock.map((subnet, index) =>
  createSubnetAndGetID(subnet, index, true)
)

// IAM role for EKS cluster
const eksClusterRole = new aws.iam.Role('eks-cluster-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: {
          Service: 'eks.amazonaws.com',
        },
      },
    ],
  }),
})

// Attach the AmazonEKSClusterPolicy to the role
new aws.iam.RolePolicyAttachment('cluster-role-policy-attachment', {
  role: eksClusterRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy',
})

// Creating EKS cluster
const eksCluster = new aws.eks.Cluster('eks-cluster', {
  roleArn: eksClusterRole.arn,
  vpcConfig: {
    subnetIds: [...privateSubnet, ...publicSubnet],
  },
  version: '1.27',
  tags: {
    name: 'my-eks-cluster',
  },
})

// Create an IAM role for EKS worker nodes
const workerNodeRole = new aws.iam.Role('worker-node-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Principal: {
          Service: 'ec2.amazonaws.com',
        },
        Effect: 'Allow',
      },
    ],
  }),
})

// Attach the EKS Worker Node, CNI and container registry policy
new aws.iam.RolePolicyAttachment('worker-node-policy-attachment', {
  role: workerNodeRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy',
})

new aws.iam.RolePolicyAttachment('cni-policy-attachment', {
  role: workerNodeRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy',
})

new aws.iam.RolePolicyAttachment('container-registry-policy-attachment', {
  role: workerNodeRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
})

// Create a Node Group
new aws.eks.NodeGroup('worker-node-group', {
  clusterName: eksCluster.name,
  nodeRoleArn: workerNodeRole.arn,
  subnetIds: [...privateSubnet, ...publicSubnet],
  scalingConfig: {
    desiredSize: desiredClusterSize,
    maxSize: maxClusterSize,
    minSize: minClusterSize,
  },
  instanceTypes: [eksNodeInstanceType],
})

// Generate the kubeconfig
const kubeconfig = pulumi
  .all([eksCluster.name, eksCluster.endpoint, eksCluster.certificateAuthority])
  .apply(([clusterName, clusterEndpoint, clusterCA]) => {
    return {
      apiVersion: 'v1',
      clusters: [
        {
          cluster: {
            server: clusterEndpoint,
            'certificate-authority-data': clusterCA.data,
          },
          name: 'kubernetes',
        },
      ],
      contexts: [
        {
          context: { cluster: 'kubernetes', user: 'aws' },
          name: 'aws',
        },
      ],
      'current-context': 'aws',
      kind: 'Config',
      users: [
        {
          name: 'aws',
          user: {
            exec: {
              apiVersion: 'client.authentication.k8s.io/v1alpha1',
              command: 'aws',
              args: ['eks', 'get-token', '--cluster-name', clusterName],
            },
          },
        },
      ],
    }
  })

// Export the cluster name, ARN and kubeconfig
export const clusterName = eksCluster.name
export const clusterArn = eksCluster.arn
export const clusterKubeConfig = kubeconfig
export const vpcId = eksVpc.id
