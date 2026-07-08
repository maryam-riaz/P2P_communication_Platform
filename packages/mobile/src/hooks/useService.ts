import { useContext } from 'react';
import { ServiceContext } from '../context/ServiceContext';

/**
 * Resolves an active service instance from the ServiceContext.
 */
export function useService<T>(ServiceClass: new (...args: any[]) => T): T {
  const services = useContext(ServiceContext);
  if (!services) {
    throw new Error('useService must be used within a ServiceContext.Provider');
  }
  
  const serviceName = ServiceClass.name;
  // Support mini-transpiled class names or direct keys
  const serviceInstance = services[serviceName] || services[serviceName.charAt(0).toLowerCase() + serviceName.slice(1)];
  
  if (!serviceInstance) {
    throw new Error(`Service ${serviceName} not found in ServiceContext`);
  }
  
  return serviceInstance as T;
}
